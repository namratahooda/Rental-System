import { prisma } from './db.js';

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run admin:promote -- user@iiita.ac.in');
  process.exitCode = 1;
} else {
  const user = await prisma.user.findUnique({where:{email}});
  if (!user) {
    console.error('No account exists for that email. Register and verify access first.');
    process.exitCode = 1;
  } else if (!user.isApproved) {
    console.error('This account is pending or rejected. Resolve its access request before promotion.');
    process.exitCode = 1;
  } else {
    await prisma.user.update({where:{id:user.id},data:{role:'ADMIN'}});
    console.log(`Promoted ${email} to administrator.`);
  }
}
await prisma.$disconnect();
