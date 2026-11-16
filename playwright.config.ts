import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests/ui', timeout:30000, fullyParallel:true,
  use:{baseURL:'http://127.0.0.1:1420',viewport:{width:480,height:700},screenshot:'only-on-failure',trace:'retain-on-failure'},
  projects:[{name:'webkit',use:{browserName:'webkit'}},{name:'chromium',use:{browserName:'chromium'}}],
  webServer:{command:'pnpm dev',url:'http://127.0.0.1:1420',reuseExistingServer:!process.env.CI},
});
