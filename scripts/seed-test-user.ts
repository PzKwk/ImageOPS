import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { config } from "../src/server/config.js";
import { updateStore } from "../src/server/store.js";

const email = "test@imageops.local";
const password = "Test123456!";

const result = await updateStore(async (store) => {
  const existing = store.users.find((user) => user.email === email);
  if (existing) {
    existing.credits = Math.max(existing.credits, 500);
    return { created: false, credits: existing.credits };
  }

  store.users.push({
    id: randomUUID(),
    email,
    name: "Test Artist",
    passwordHash: await bcrypt.hash(password, 12),
    credits: 500,
    createdAt: new Date().toISOString()
  });

  return { created: true, credits: 500 };
});

console.log(
  JSON.stringify(
    {
      backend: config.dataBackend,
      email,
      password,
      ...result
    },
    null,
    2
  )
);
