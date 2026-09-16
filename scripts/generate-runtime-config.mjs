import { readFile, writeFile } from 'node:fs/promises';

const envPath = new URL('../.env', import.meta.url);
const outputPath = new URL('../runtime-config.js', import.meta.url);
const envText = await readFile(envPath, 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
const required = ['PUBLIC_FIREBASE_API_KEY', 'PUBLIC_FIREBASE_AUTH_DOMAIN', 'PUBLIC_FIREBASE_PROJECT_ID', 'PUBLIC_FIREBASE_STORAGE_BUCKET', 'PUBLIC_FIREBASE_MESSAGING_SENDER_ID', 'PUBLIC_FIREBASE_APP_ID'];
const missing = required.filter(key => !env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
const firebaseConfig = {
  apiKey: env.PUBLIC_FIREBASE_API_KEY,
  authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: env.PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.PUBLIC_FIREBASE_APP_ID,
  ...(env.PUBLIC_FIREBASE_MEASUREMENT_ID ? { measurementId: env.PUBLIC_FIREBASE_MEASUREMENT_ID } : {})
};
await writeFile(outputPath, `export const firebaseConfig = ${JSON.stringify(firebaseConfig, null, 2)};\n`);
