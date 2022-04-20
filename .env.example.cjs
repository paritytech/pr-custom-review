// Copy this file to .env.cjs and replace the placeholders

// All environment variables are required unless explicitly told otherwise

// Defines a port for the HTTP server
process.env.PORT ??= 3000

/*
  Guidance for registering a token is provided at
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token
*/
process.env.GITHUB_ACCESS_TOKEN ??= "placeholder"

/*
  NOT REQUIRED
  Set LOG_FORMAT to "json" for JSON logging
*/
// process.env.LOG_FORMAT ??= "json"
