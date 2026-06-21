import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { AppError } from "./http.js";
import { toPublicUser, updateStore, type PublicUser } from "./store.js";

const registerSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase().trim()),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(200)
});

const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase().trim()),
  password: z.string().min(1).max(200)
});

export type AuthenticatedRequest = Request & {
  user: PublicUser;
};

function signToken(user: PublicUser) {
  return jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: "7d" });
}

export async function registerUser(body: unknown) {
  const input = registerSchema.parse(body);
  const passwordHash = await bcrypt.hash(input.password, 12);

  const publicUser = await updateStore((store) => {
    const existing = store.users.find((user) => user.email === input.email);
    if (existing) {
      throw new AppError(409, "email_taken", "Diese E-Mail ist bereits registriert.");
    }

    const user = {
      id: randomUUID(),
      email: input.email,
      name: input.name,
      passwordHash,
      credits: config.startingCredits,
      createdAt: new Date().toISOString()
    };

    store.users.push(user);
    return toPublicUser(user);
  });

  return { user: publicUser, token: signToken(publicUser) };
}

export async function loginUser(body: unknown) {
  const input = loginSchema.parse(body);

  const user = await updateStore(async (store) => {
    const existing = store.users.find((storedUser) => storedUser.email === input.email);
    if (!existing) {
      throw new AppError(401, "invalid_credentials", "E-Mail oder Passwort stimmt nicht.");
    }

    const valid = await bcrypt.compare(input.password, existing.passwordHash);
    if (!valid) {
      throw new AppError(401, "invalid_credentials", "E-Mail oder Passwort stimmt nicht.");
    }

    return toPublicUser(existing);
  });

  return { user, token: signToken(user) };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      throw new AppError(401, "missing_token", "Bitte anmelden.");
    }

    const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    const userId = payload.sub;
    if (typeof userId !== "string") {
      throw new AppError(401, "invalid_token", "Die Sitzung ist ungueltig.");
    }

    const user = await updateStore((store) => {
      const stored = store.users.find((item) => item.id === userId);
      if (!stored) {
        throw new AppError(401, "invalid_token", "Die Sitzung ist ungueltig.");
      }
      return toPublicUser(stored);
    });

    (req as AuthenticatedRequest).user = user;
    next();
  } catch (error) {
    next(error);
  }
}
