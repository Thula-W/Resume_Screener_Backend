import {prisma} from "../utils/prisma.ts";

const user = await prisma.user.create({
  data: {
    firebaseUid: "test_firebase_uid",
    email: "test@example.com",
  },
});

console.log(user);

async function main() {
  const users = await prisma.user.findMany();
  console.log("Users:", users);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
