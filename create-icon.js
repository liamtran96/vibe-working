const fs = require('fs');
const zlib = require('zlib');

// Create a simple PNG
const width = 32, height = 32;

const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function crc32(data) {
  let crc = 0xffffffff;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeData = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([length, typeData, crc]);
}

function createPNG(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8); ihdr.writeUInt8(2, 9); // 8-bit RGB
  
  const rawData = [];
  for (let y = 0; y < h; y++) {
    rawData.push(0);
    for (let x = 0; x < w; x++) rawData.push(79, 70, 229); // Purple
  }
  
  const compressed = zlib.deflateSync(Buffer.from(rawData));
  return Buffer.concat([
    pngHeader,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0))
  ]);
}

// Create ICO file (simple format)
function createICO(pngBuffer) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // Number of images
  
  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(32, 0);  // Width
  dirEntry.writeUInt8(32, 1);  // Height
  dirEntry.writeUInt8(0, 2);   // Colors
  dirEntry.writeUInt8(0, 3);   // Reserved
  dirEntry.writeUInt16LE(1, 4); // Color planes
  dirEntry.writeUInt16LE(32, 6); // Bits per pixel
  dirEntry.writeUInt32LE(pngBuffer.length, 8); // Size
  dirEntry.writeUInt32LE(22, 12); // Offset (6 + 16)
  
  return Buffer.concat([header, dirEntry, pngBuffer]);
}

fs.mkdirSync('src-tauri/icons', { recursive: true });

const png32 = createPNG(32, 32);
const png128 = createPNG(128, 128);

fs.writeFileSync('src-tauri/icons/32x32.png', png32);
fs.writeFileSync('src-tauri/icons/128x128.png', png128);
fs.writeFileSync('src-tauri/icons/icon.ico', createICO(png32));

console.log('Icons created successfully');
