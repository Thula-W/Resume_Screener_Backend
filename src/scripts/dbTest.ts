import {prisma} from "../utils/prisma.ts";

async function main() {
  const users = await prisma.user.findMany();
  console.log("Users:", users);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
