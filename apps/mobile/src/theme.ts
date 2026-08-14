/** Mirrors apps/web's CSS variables (see apps/web/src/app/globals.css) so both surfaces feel like one product. */
export const lightTheme = {
  bg: "#f5f7fa",
  bgElevated: "#ffffff",
  bgInset: "#eef1f6",
  text: "#12161c",
  textMuted: "#5b6472",
  border: "#e2e6ec",
  accent: "#4f6bff",
  accentSoft: "#eef1ff",
  accentContrast: "#ffffff",
  good: "#17a673",
  goodSoft: "#e6f7f0",
  warn: "#e0a52c",
  bad: "#e0553f",
  badSoft: "#fceae6",
  stageAwake: "#e0553f",
  stageRem: "#7c8cff",
  stageLight: "#9fb4ff",
  stageDeep: "#38439e",
};

export const darkTheme: typeof lightTheme = {
  bg: "#0c0e13",
  bgElevated: "#14171f",
  bgInset: "#1a1e28",
  text: "#eef1f6",
  textMuted: "#8b93a4",
  border: "#262b38",
  accent: "#7c8cff",
  accentSoft: "#1c2040",
  accentContrast: "#0c0e13",
  good: "#34d399",
  goodSoft: "#0e2a22",
  warn: "#f2c14e",
  bad: "#f0705a",
  badSoft: "#2c1712",
  stageAwake: "#f0705a",
  stageRem: "#9aa6ff",
  stageLight: "#4f5eb0",
  stageDeep: "#262e6e",
};

export type Theme = typeof lightTheme;
