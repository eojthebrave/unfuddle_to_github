#!/usr/bin/env node
/**
 * @file
 */

// app.js -d --backup="/Users/joe/Sites/_lullabot/drupalize_me/lullabot.drupalschool.20130111144200"

// Include all the libraries we're going to use.
var path = require('path')
  // AWS for uploading files to S3.
  , AWS = require('aws-sdk')
  // Local file system manipulation.
  , fs = require('fs')
  , util = require('util')
  // Access to the GitHub API.
  , GitHubApi = require("github")
  , github = new GitHubApi({version: "3.0.0"})
  // XML parser to read Unfuddle's output.
  , xml2js = require('xml2js')
  // Magic.
  , _ = require('underscore')
  , flow = require('flow');

// Load the apps configuration.
var config = require('./config.js');

// Parse and provide help for command line arguments with optimist.
var argv = require('optimist')
  .usage('Usage: $0 -d --file [path to Unfuddle XML file] --repo [GitHub repo name] --user [GitHub username to use for authentication and defaults] --pass [GitHub user password')
  .demand(['backup'])
  .describe('backup', 'Path to Unfuddle XML directory that contains the data to import')
  .describe('d', 'Operate in debug mode, do not make actual API requests to GitHub')
  .argv;

// Set some globals.
var BACKUP_DIR = argv.backup;
var BACKUP_FILE = BACKUP_DIR + '/backup.xml';
var DEFAULT_USER = config.gitHubUsername;
var DEFAULT_ISSUE_USER = config.gitHubDefaultIssueUsername;
var REPO = config.gitHubRepository;
var TOTAL_TICKETS = 0;
var TOTAL_TICKETS_COMPLETE = 0;

// Load our AWS config data.
//AWS.config.loadFromPath('./aws-config.json');
AWS.config.update(config.aws_credentials);
var s3 = new AWS.S3();

if (!argv.d) {
  github.authenticate({
      type: "oauth",
      // username: config.gitHubUsername,
      // password: config.gitHubPassword,
      token: config.gitHubToken,

  }, function(err) {
    console.log(err);
  });
}

/**
 * Determine file mime-type for a file based on filename extensions.
 *
 * @param fileName
 *   Filename to check for mime-type.
 * @returns {string}
 *   The file mime-type.
 */
function getContentTypeByFile(fileName) {
  var rc = 'application/octet-stream';
  var fn = fileName.toLowerCase();

  if (fn.indexOf('.html') >= 0) rc = 'text/html';
  else if (fn.indexOf('.css') >= 0) rc = 'text/css';
  else if (fn.indexOf('.json') >= 0) rc = 'application/json';
  else if (fn.indexOf('.js') >= 0) rc = 'application/x-javascript';
  else if (fn.indexOf('.png') >= 0) rc = 'image/png';
  else if (fn.indexOf('.jpg') >= 0) rc = 'image/jpg';

  return rc;
}

/**
 * GitHub Import class.
 * @constructor
 */
var GHImport = function() {
  var _this = this;

  this.milestone_map = {};
  this.component_map = {};
  this.field_map = {};
  this.upload_results = [];

  this.user_map = config.user_map;

  this.readComponentValues = function(components, callback) {
    _.each(components, function(component) {
      _this.component_map[component.id[0]] = component.name[0];
    });

    console.log('Component values read from XML.');
    callback();
  };

  this.readFieldValues = function(fields, callback) {
    _.each(fields, function(field) {
      _this.field_map[field.id[0]] = field.value[0];
    });

    console.log('Field values ready from XML.');
    callback();
  };

  this.createMilestones = function(milestones, callback) {
    github.issues.getAllMilestones({user: DEFAULT_USER, repo: REPO, state: 'all', per_page: 100}, function(err, res) {
      flow.serialForEach(res, function(milestone) {
        var cb = this;
        github.issues.deleteMilestone({user: DEFAULT_USER, repo: REPO, number: milestone.number}, function(err, res) {
          cb();
        });
        console.log('Milestone deleted: ' + milestone.title);
      },
      function(error) {
        if (error) {
          throw error;
        }
      },
      function() {
        flow.serialForEach(milestones, function(milestone) {
          var cb = this;
          var gh_milestone = {
            'user': DEFAULT_USER,
            'title': milestone.title[0],
            'state': (milestone.completed[0] == 'false') ? 'open' : 'closed',
            'description': milestone.description[0],
            'repo': REPO
          };

          if (!argv.d) {
            github.issues.createMilestone(gh_milestone, function(err, res) {

              // Store the new GitHub milestone ID. We'll need this to create
              // tickets later.
              _this.milestone_map[milestone.id[0]] = res.number;

              console.log('Milestone saved: ' + gh_milestone.title);
              cb();
            });
          }
          else {
            console.log('DEBUG: Milestone saved: ' + gh_milestone.title);
            cb();
          }
        },
        function(error) {
          if (error) {
            throw error;
          }
        },
        function() {
          callback();
        });
      });
    });
  };

  /**
   * Save an issue to GitHub.
   *
   * @param issue
   *   An object representation of a GitHub issue.
   */
  this.saveIssue = function(issue, cb) {
    // Create the issue.
    if (!argv.d) {
      github.issues.create(issue, function(err, res) {
        issue.number = res.number;
        // @todo, log that the issue was created?

        TOTAL_TICKETS_COMPLETE++;
        console.log('(' + TOTAL_TICKETS_COMPLETE + '/' + TOTAL_TICKETS + ') Saved issue: ' + issue.title);
        cb(issue);
      });
    }
    else {
      console.log('DEBUG: Saved issue: ' + issue.title);
      cb(issue);
    }
  }

  /**
   * Close an issue to GitHub.
   *
   * @param issue
   *   An object representation of a GitHub issue.
   */
  this.closeIssue = function(issue, cb) {
    // Create the issue.
    if (!argv.d) {
      issue.state = 'closed';
      github.issues.edit(issue, function(err, res) {
        console.log('Closed issue: ' + issue.title);
        cb(issue);
      });
    }
    else {
      console.log('DEBUG: Closed issue: ' + issue.title);
      cb(issue);
    }
  }

  /**
   * Create all the comments for a given issue and associate them with the issue.
   *
   * @param comments
   *   An array of comment objects pulled from Unfuddle XML.
   * @param issue
   *   The GitHub issue that each new comment should be associated with.
   * @param callback
   *   Callback that should be executed after all comments have been processed.
   */
  this.createComments = function(comments, issue, callback) {
    flow.serialForEach(comments[0]['comment'], function(content) {
      var serialCb = this;
      var body = content['body'][0];
      body = body + "\n\nUF Created: " + content['created-at'][0] + " User: " + content['author-id'][0];
      var comment = {
        // Comments which belong to an Unfuddle user for which we have no
        // GitHub user are just assigned to the default user for the
        // script. It's not great, but it'll work.
        'user': (typeof _this.user_map[content['author-id'][0]] === 'string') ? _this.user_map[content['author-id'][0]] : DEFAULT_ISSUE_USER,
        'repo': REPO,
        'number': issue.number,
        'body': body
      };

      // We need to run these events in order since we can't create the new
      // comment until after uploading any associated files has finished.
      flow.exec(
        // Handle any files attached to comments.
        function() {
          var cb = this;
          // The typeof content['attachments'][0] check is required here
          // because sometimes the attachments contain nothing but an empty
          // string with a single newline character.
          if (typeof content['attachments'] === 'object' && typeof content['attachments'][0] === 'object') {
            var files = _.toArray(content['attachments'][0]);
            _.each(files, function(value) {
              // Use multiplexing here so we can upload multiple files in
              // parallel.
              _this.handleAttachment(value[0], cb.MULTI());
            });
          }
          else {
            cb();
          }
        },
        function(uploaded_files) {
          _.each(uploaded_files, function(file) {
            comment.body += "\nAttached file: " + file[0];
          });
          this();
        },
        // Save the new comment.
        function() {
          _this.saveComment(comment, this);
        },
        function() {
          serialCb();
        }
      );
    },
    function(error) {
      if (error) {
        throw error;
      }
    },
    function() {
      callback(issue);
    });
  }

  /**
   * Save a comment to GitHub.
   *
   * @param comment
   *   An object representation of a GitHub issue comment..
   * @param cb
   *   Callable to execute after the comment has been saved.
   */
  this.saveComment = function(comment, cb) {
    if (!argv.d) {
      github.issues.createComment(comment, function(err, res) {
        // @todo, log that the comment was created?

        console.log('Saved comment to issue: ' + comment.number);
        cb(comment);
      });
    }
    else {
      console.log('DEBUG: Saved comment to issue: ' + comment.number);
      cb(comment);
    }
  }

  /**
   * Loop over list of tickets and create a GitHub issue for each one.
   *
   * @param tickets
   * @param callback
   */
  this.createIssues = function(tickets, callback) {
    TOTAL_TICKETS = tickets.length;

    flow.serialForEach(tickets, function(ticket) {
      var serialCb = this;

      // Stub the new GitHub issue.
      var issue = {
        'user': DEFAULT_USER,
        'repo': REPO,
        'title': ticket.summary[0],
        'body': ticket.description[0]
      };

      // If the Unfuddle ticket has an assignee and we are able to map the
      // Unfuddle users ID to a GitHub account we can set the assignee of the
      // new GitHub issue here.
      if (typeof ticket['assignee-id'][0] == 'string' && typeof _this.user_map[ticket['assignee-id'][0]] == 'string') {
        issue.assignee = _this.user_map[ticket['assignee-id'][0]];
      }

      // Set a milestone for the ticket if there is one.
      if (typeof ticket['milestone-id'][0] == 'string' && ticket['milestone-id'][0] != '') {
        issue.milestone = _this.milestone_map[ticket['milestone-id'][0]];
      }

      // Map Unfuddle component and field values to GitHub labels since GitHub
      // doesn't have equivalent custom fields.
      issue.labels = new Array();
      if (typeof ticket['component-id'][0] == 'string' && typeof _this.component_map[ticket['component-id'][0]] == 'string') {
        issue.labels.push(_this.component_map[ticket['component-id'][0]]);
      }

      if (typeof ticket['field1-value-id'][0] == 'string' && typeof _this.field_map[ticket['field1-value-id'][0]] == 'string') {
        issue.labels.push(_this.field_map[ticket['field1-value-id'][0]]);
      }

      // Add a label for priority.
      if (typeof ticket['priority'][0] == 'string') {
        issue.labels.push('p' + ticket['priority'][0]);
      }

      // If the ticket is "closed" or "fixed" or has some other content in the
      // "resolution" field we should extract that and add it at the bottom of
      // the main issue post so that it doesn't get lost.
      if (typeof ticket['resolution-description'][0] == 'string' && ticket['resolution-description'][0].length > 0) {
        issue.body += "\n\n";
        issue.body += "**Resolution Message**\n";
        issue.body += ticket['resolution-description'][0];
      }

      // With the new issue stubbed we need to make sure we do the next few tasks
      // in order.
      flow.exec(
        // Upload any files associated with this ticket to S3 so we can link to
        // them from GitHub.
        function() {
          var cb = this;

          // Loop over every file if there are any, and upload.
          if (typeof ticket['attachments'] == 'object' && typeof ticket['attachments'][0] == 'object') {
            var files = _.toArray(ticket['attachments'][0]);
            _.each(files, function(value) {
              // Use multiplexing here so we can upload multiple files in
              // parallel.
              _this.handleAttachment(value[0], cb.MULTI());
            });
          }
          else {
            cb();
          }
        },
        // Associate any uploaded files with the issue we're composing. We just
        // tack these on to the end of the issue body if there are any.
        function (uploaded_files) {
          _.each(uploaded_files, function(file) {
            issue.body += "\nAttached file: " + file[0];
          });

          this();
        },
        // Save the issue.
        function() {
          issue = _this.saveIssue(issue, this);
        },
        // Handle comments associated with an issue.
        function(issue) {
          // The typeof ticket.comments[0] check is required here
          // because sometimes the comments contain nothing but an empty string
          // with a single newline character.
          if (typeof ticket.comments === 'object' && typeof ticket.comments[0] === 'object') {
            _this.createComments(ticket.comments, issue, this);
          }
          else {
            this(issue);
          }
        },
        function(issue) {
          if (ticket.status[0] === 'closed') {
            _this.closeIssue(issue, this);
          }
          else {
            this();
          }
        },
        function() {
          serialCb();
        }
      )
    },
    function(error) {
      if (error) {
        throw error;
      }
    },
    function() {
      callback();
    });
  };

  /**
   * Process the attachments associated with a ticket then continue to callback.
   *
   * Uploads any attachments to S3 and then calls the callback function which
   * should save the data object to GitHub.
   *
   * @param attachment
   * @returns {*}
   */
  this.handleAttachment = function(attachment, cb) {
    // The local file name is the unique ID of the file.
    var local_file = BACKUP_DIR + '/media/attachments/' + attachment.id[0];
    var remote_file = 'unfuddle_imports/' + attachment.filename[0];

    // Copy the file to S3.
    var fileContent = fs.readFileSync(local_file, 'utf-8');
    var metaData = getContentTypeByFile(local_file);
    // @todo make bucket configurable.
    var params = {Bucket: 'testing-joe', Key: remote_file, Body: fileContent, ContentType: metaData};
    var uploaded_files = [];

    s3.client.putObject(params, function (err, data) {
      if(err) return console.log(err);

      // Construct a URL for a newly uploaded file.
      // @todo, make this url configurable.
      var file = 'http://' + 'testing-joe.s3.amazonaws.com/' + remote_file;

      console.log('Uploaded ' + remote_file + ' to S3');
      cb(file);
    });
  }
};

var importer = new GHImport();

// Instantiate the xml2js parser.
var parser = new xml2js.Parser();

// Read in the unfuddle XML backup file.
fs.readFile(BACKUP_FILE, function(err, data) {
  parser.parseString(data, function (err, result) {
    flow.exec(
      function() {
        var cb = this;

        // Read in component data so we can use it for mapping to labels later.
        _.each(result.account.projects[0].project[0].components, function(element, index, list) {
          importer.readComponentValues(element.component, cb.MULTI());
        });
      },
      function() {
        var cb = this;

        // Read in values for custom field 1.
        _.each(result.account.projects[0].project[0].custom_field_values, function(element, index, list) {
          importer.readFieldValues(element['custom-field-value'], cb.MULTI());
        });
      },
      function() {
        var cb = this;

        // Milestones.
        _.each(result.account.projects[0].project[0].milestones, function(element, index, list) {
          importer.createMilestones(element.milestone, cb.MULTI());
        });
      },
      function() {
        var cb = this;

        // Tickets.
        _.each(result.account.projects[0].project[0].tickets, function(element, index, list) {
          importer.createIssues(element.ticket, cb.MULTI());
        });
      },
      function() {
        console.log('Done!');
      }
    );
  });
});
