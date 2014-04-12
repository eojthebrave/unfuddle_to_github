**SETUP**

Clone this repository.

Install all dependencies by running `npm install` in the root directory of the cloned repository.

Copy the `config.js.sample` file to `config.js` and update it with your information.

**CAUTION** This is still very much a work in progress, and as such the setup is a bit janky. Use at your own risk.

In order to proceed you'll need to get an archive of the content of your Unfuddle account. You can find out more about exporting your Unfuddle project(s) here: https://unfuddle.com/support/docs/backups

Download the archive and unpack it somewhere you can have easy access to it's contents.

The GitHub API doesn't currently support adding files (like a screenshot) to an issue via the API. Unfuddle however does, so you might have files attached to your existing issues. In order to deal with this scenario this script is setup to upload those files to S3 and then add a link to the body of the issue or comment as necessary.

In order for this script to be able to upload files to S3 you'll need to add AWS configuration to your config.js file in the root directory.

**NOTE:** The S3 bucket/path is hard-coded into the script right now and this should be made configurable.

Usage example:

`app.js -d --backup="/Users/joe/Sites/_lullabot/drupalize_me/lullabot.drupalschool.20130111144200"`

`config.user_map`

This serves as a mapping between Unfuddle user ID and GitHub username so that we can attempt to keep issues and comments associated with the appropriate person.

Unfuddle has "custom fields" for tickets, GitHub has no equivalent. There's code in place that handles my specific use case which simply takes the custom field values and turns them into labels for GitHub issues, but you might want to look at and tweak this for your use-case.