import { prisma } from "./lib/prisma";

async function main() {
  const users = await prisma.user.findMany();
  console.log("Users:", users);

  
}

main()
  .then(() => {
    console.log("✅ Prisma 7 test finished");
    process.exit(0);
  })
  .catch((e) => {
    console.error("❌ Prisma 7 test error:", e);
    process.exit(1);
  });
