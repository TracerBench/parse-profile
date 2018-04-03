# SC-HASHES-TRANSFORM

## Usage

`# node sc-hashes-transform.js <sc-hashes.json file> <profile.json file>`

This will output the transformed profile.json to stdout.

## Where to get sc-hashes.json

When you get the trace for voyager-web, inspect the html and look for a meta tag with the name, "serviceVersion".

`<meta name="serviceVersion" content="1.1.5393" />`

You can either:

- Search https://go.corp.linkedin.com/artifactory for: `voyager-web_prod_build-<version>.tgz`.
- Try to download directly by modifying this url to have the right version:
  - https://artifactory.corp.linkedin.com:808/artifactory/CNC/com/linkedin/voyager-web/voyager-web/<version>/voyager-web_prod_build-<version>.tgz
  
After downloading the correct version, untar the file navigate inside and look for:

- `./web_client_build/extended/sc-hashes.json` or
- `./web_client_build/core/sc-hashes.json` depending on your use case.