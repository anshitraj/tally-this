export const PRODUCT_NAME = "TallyThis";
export const CONTACT_EMAIL = "contact@tallythis.xyz";

export function supportEmail(): string {
  return process.env.SUPPORT_EMAIL?.trim() || CONTACT_EMAIL;
}
