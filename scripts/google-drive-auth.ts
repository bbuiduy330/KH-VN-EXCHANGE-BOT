#!/usr/bin/env node
import "dotenv/config";
import readline from "readline";
import { google } from "googleapis";

/**
 * Google Drive OAuth 2.0 Refresh Token Generator Helper Script
 *
 * This script guides the developer through obtaining an OAuth 2.0 refresh token
 * for a personal Google Drive account.
 *
 * Usage:
 *   npx tsx scripts/google-drive-auth.ts
 *
 * Steps:
 * 1. Loads GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET from environment or prompts.
 * 2. Generates an OAuth 2.0 consent authorization URL with offline access and consent prompt.
 * 3. Prompts the developer to paste the authorization code returned after consent.
 * 4. Exchanges the code for tokens and outputs the GOOGLE_DRIVE_REFRESH_TOKEN.
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("================================================================");
  console.log(" Google Drive OAuth 2.0 Refresh Token Generator");
  console.log("================================================================\n");

  let clientId = process.env.GOOGLE_DRIVE_CLIENT_ID?.trim();
  if (!clientId) {
    clientId = await ask("Enter GOOGLE_DRIVE_CLIENT_ID: ");
  }

  let clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    clientSecret = await ask("Enter GOOGLE_DRIVE_CLIENT_SECRET: ");
  }

  let redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI?.trim();
  if (!redirectUri) {
    const inputUri = await ask(
      "Enter Redirect URI (default: http://localhost:3000/oauth2callback or http://localhost): "
    );
    redirectUri = inputUri || "http://localhost:3000/oauth2callback";
  }

  if (!clientId || !clientSecret) {
    console.error("\n❌ Error: Client ID and Client Secret are required.");
    rl.close();
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  /**
   * Scope Choice:
   * We request 'https://www.googleapis.com/auth/drive'.
   *
   * Why:
   * The bot archives evidence into a pre-existing root folder (GOOGLE_DRIVE_ROOT_FOLDER_ID)
   * created in the personal Google Drive. The restricted scope 'drive.file' only allows
   * access to files created or opened by the application itself; it cannot locate or write
   * to existing folders created manually by the user in Google Drive unless granted 'drive' scope.
   */
  const scopes = [
    "https://www.googleapis.com/auth/drive"
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes
  });

  console.log("\n----------------------------------------------------------------");
  console.log("Step 1: Open the following URL in your web browser:\n");
  console.log(authUrl);
  console.log("----------------------------------------------------------------\n");
  console.log(
    "Step 2: Sign in with your personal Google account and approve permissions.\n" +
    "Step 3: After approval, you will be redirected to your Redirect URI.\n" +
    "        Copy the 'code' query parameter from the browser URL address bar.\n" +
    "        (Example URL: http://localhost:3000/oauth2callback?code=4/0AcvD...)\n"
  );

  const authCode = await ask("Enter the authorization code: ");

  if (!authCode) {
    console.error("\n❌ Error: Authorization code cannot be empty.");
    rl.close();
    process.exit(1);
  }

  try {
    console.log("\nExchanging authorization code for tokens...");
    const { tokens } = await oauth2Client.getToken(authCode);

    if (!tokens.refresh_token) {
      console.warn("\n⚠️ Warning: Google did not return a refresh token.");
      console.warn("Reason: You may have already authorized this app previously without prompt='consent'.");
      console.warn("To force a refresh token, revoke access at https://myaccount.google.com/permissions and run this script again.");
    } else {
      console.log("\n================================================================");
      console.log("✅ SUCCESS! Copy the following line into your .env file:");
      console.log("================================================================\n");
      console.log(`GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
      console.log("================================================================");
      console.log("Security Note: Never commit your .env file or share this refresh token!");
    }
  } catch (err: any) {
    const errorMsg = err?.response?.data?.error_description || err?.message || "Token exchange failed";
    console.error(`\n❌ Failed to obtain refresh token: ${errorMsg}`);
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  rl.close();
  process.exit(1);
});
