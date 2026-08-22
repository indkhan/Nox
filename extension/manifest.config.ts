import { defineManifest } from '@crxjs/vite-plugin'

const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAk34/PLF2O0uaReFhW8ISpW3LlAi7YfvSIYZ6+sVu5l5eWvFqYduf19vaeuKWZqcVoUGsjt8VGc5ptbDCa8IGgYJtq8w253uthpS875gleig/IPB4hXC3zG9ubkZFwgeIBdgcfzPkbLrdQlrNzzEM7iSAV2uN2pD0I5vroIZrIKo6pbMuy8/oc6r3iAJaivf1oZOLYalB3ws1erYuJFSDF8ULtM000digZHH7RRdvySe+lt1RJ46N6T1Xmrrq6lFcnxbO/N+3CBc4MX68K1+WEubqPFxS4pGrvXlG+i58lGa8hCQL7iSZcxXKr5aZgf9gsJUdiQz3ImL7Psj7O+XWxwIDAQAB'

export default defineManifest({
  manifest_version: 3,
  name: 'Nox',
  version: '0.1.0',
  description: 'Notion workspace assistant.',
  key: PUBLIC_KEY,
  permissions: [
    'sidePanel',
    'storage',
    'unlimitedStorage',
    'identity',
    'tabs',
    'nativeMessaging',
    'declarativeNetRequest',
    'declarativeNetRequestWithHostAccess',
  ],
  host_permissions: [
    'https://*.notion.so/*',
    'https://*.notion.com/*',
    'https://mcp.notion.com/*',
  ],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  action: {
    default_title: 'Open Nox',
  },
})
