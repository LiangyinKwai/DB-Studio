const moduleName = process.env.DB_STUDIO_PLAYWRIGHT_MODULE || "playwright";
export const { chromium } = await import(moduleName);
