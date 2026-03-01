const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const assetsDir = path.join(__dirname, '..', 'assets');

// Ensure assets directory exists
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

// Create a simple colored circle icon
async function createTrayIcon(color, filename, size = 32) {
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 2}" fill="${color}" />
      <text x="${size/2}" y="${size/2 + 4}" text-anchor="middle" fill="white" font-size="${size/2.5}" font-family="Arial" font-weight="bold">S</text>
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(path.join(assetsDir, filename));

  console.log(`Created ${filename}`);
}

// Create main app icon (larger, more detailed)
async function createAppIcon(size = 256) {
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#6366F1;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#4F46E5;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" rx="${size/8}" fill="url(#grad)" />
      <text x="${size/2}" y="${size/2 + size/6}" text-anchor="middle" fill="white" font-size="${size/2}" font-family="Arial" font-weight="bold">S</text>
      <path d="M ${size*0.2} ${size*0.75} Q ${size*0.5} ${size*0.65} ${size*0.8} ${size*0.75}" stroke="white" stroke-width="${size/20}" fill="none" opacity="0.5"/>
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(path.join(assetsDir, 'icon.png'));

  console.log('Created icon.png');
}

async function main() {
  try {
    // Create tray icons (32x32)
    await createTrayIcon('#10B981', 'tray-connected.png', 32);    // Green - connected
    await createTrayIcon('#EF4444', 'tray-disconnected.png', 32); // Red - disconnected
    await createTrayIcon('#F59E0B', 'tray-syncing.png', 32);      // Yellow - syncing
    await createTrayIcon('#EF4444', 'tray-error.png', 32);        // Red - error

    // Create main app icon
    await createAppIcon(256);

    console.log('\nAll icons created successfully!');
    console.log('Note: For production, create a proper .ico file using a tool like png-to-ico');

  } catch (error) {
    console.error('Error creating icons:', error);
    process.exit(1);
  }
}

main();
