import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

const getPepperedPassword = (plainPassword) => {
  const pepper = process.env.PASSWORD_PEPPER || 'liaquatabad_dmc_default_pepper_key_2026';
  return `${plainPassword}${pepper}`;
};

export const hashPassword = async (plainPassword) => {
  const peppered = getPepperedPassword(plainPassword);
  return await bcrypt.hash(peppered, SALT_ROUNDS);
};

export const verifyPassword = async (plainPassword, hashedPassword) => {
  const peppered = getPepperedPassword(plainPassword);
  return await bcrypt.compare(peppered, hashedPassword);
};
