import { t } from "@/i18n";

export const APP_NAME = "飞梭";
export const APP_NAME_EN = "Feisuo";
export const APP_VERSION = __APP_VERSION__;
export const FAMILY_NAME = "开物";
export const FAMILY_NAME_EN = "Kaiwu";

export function appTagline() {
  return t("brand.tagline");
}

export function appTitle() {
  return `${APP_NAME} · ${appTagline()}`;
}

export function appFamilyRole() {
  return t("brand.familyRole");
}
