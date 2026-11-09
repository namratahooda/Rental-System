import { prisma } from './db.js';
const categories = ['Electronics','Books & Novels','Apparel','Kitchen','Sports','Transport','Games','Miscellaneous'];
for (const name of categories) await prisma.category.upsert({where:{slug:name.toLowerCase().replaceAll(/[^a-z0-9]+/g,'-')},update:{name},create:{name,slug:name.toLowerCase().replaceAll(/[^a-z0-9]+/g,'-')}});
console.log(`Seeded ${categories.length} categories.`); await prisma.$disconnect();
