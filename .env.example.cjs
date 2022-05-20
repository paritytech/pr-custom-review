// Copy this file to .env.cjs and replace the placeholders

// All environment variables are required unless explicitly told otherwise

// Defines a port for the HTTP server
process.env.PORT ??= 3000

/*
  Guidance for registering a token is provided at
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token
  It can be manually encoded with `base64 -w 0 <<< "token"`
*/
process.env.GITHUB_ACCESS_TOKEN ??=
  Buffer.from("placeholder").toString("base64")

/*
  NOT REQUIRED
  Set LOG_FORMAT to "json" for JSON logging
*/
// process.env.LOG_FORMAT ??= "json"
