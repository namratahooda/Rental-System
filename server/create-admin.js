import bcrypt from 'bcryptjs';
import { prisma } from './db.js';

function readPassword() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return new Promise((resolve) => {
      let value = '';
      process.stdin.setEncoding('utf8').on('data', (chunk) => {
        value += chunk;
        const newline = value.indexOf('\n');
        if (newline !== -1) resolve(value.slice(0, newline).replace(/\r$/, ''));
      });
    });
  }

  process.stdout.write('Admin password (input hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    process.stdin.on('data', (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          process.stdin.setRawMode(false);
          process.exit(130);
        } else if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(value);
        } else if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    });
  });
}

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run admin:create -- email@example.com < password.txt');
  process.exitCode = 1;
} else {
  const password = await readPassword();

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exitCode = 1;
  } else if (await prisma.user.findUnique({ where: { email } })) {
    console.error('An account already exists for that email; no changes were made.');
    process.exitCode = 1;
  } else {
    await prisma.user.create({
      data: {
        fullName: 'Rentol Administrator',
        email,
        passwordHash: await bcrypt.hash(password, 12),
        role: 'ADMIN',
        isApproved: true,
      },
    });
    console.log(`Created administrator account for ${email}.`);
  }
}

await prisma.$disconnect();
