// Copy this file to .env.cjs and replace the placeholders

// All environment variables are required unless explicitly told otherwise

// Set LOG_FORMAT to "json" for JSON logging or leave it as "none"
process.env.LOG_FORMAT ??= "none"

// Defines a port for the HTTP server
process.env.PORT ??= 3000

/*
  Guidance for registering an app is at:
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token
*/
process.env.GITHUB_ACCESS_TOKEN ??= "placeholder"
