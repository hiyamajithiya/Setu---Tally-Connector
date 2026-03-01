#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

// Remove ELECTRON_RUN_AS_NODE from environment
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Find electron executable
const electronPath = require('electron');

// Spawn electron with clean environment
const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env,
  cwd: __dirname
});

child.on('close', (code) => {
  process.exit(code || 0);
});
