const configModule = await import('/runtime-config.js');
const firebaseConfig = configModule.firebaseConfig;

if (!firebaseConfig?.apiKey || !firebaseConfig?.projectId || !firebaseConfig?.appId) {
  throw new Error('Firebase runtime configuration is missing. Generate runtime-config.js from .env before starting the app.');
}

export { firebaseConfig };
