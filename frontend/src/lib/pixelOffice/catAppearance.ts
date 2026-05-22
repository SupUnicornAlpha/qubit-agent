import type { CatBreed } from "./types";

const BREEDS: CatBreed[] = [
  "tabby",
  "black",
  "white",
  "calico",
  "siamese",
  "british",
  "tuxedo",
  "ginger",
];

function hashRole(role: string): number {
  let h = 0;
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function breedForRole(role: string): CatBreed {
  return BREEDS[hashRole(role) % BREEDS.length]!;
}

export type CatPalette = {
  body: string;
  bodyDark: string;
  belly: string;
  ear: string;
  eye: string;
  nose: string;
  stripe?: string;
  mask?: string;
};

export function paletteForBreed(breed: CatBreed): CatPalette {
  switch (breed) {
    case "black":
      return { body: "#2d2d3a", bodyDark: "#1a1a24", belly: "#3d3d4a", ear: "#1a1a24", eye: "#8cf0a0", nose: "#e8a0b8" };
    case "white":
      return { body: "#e8e4dc", bodyDark: "#c8c4bc", belly: "#f8f4ec", ear: "#d0ccc4", eye: "#4a90c8", nose: "#f0a0b0" };
    case "calico":
      return {
        body: "#e8c890",
        bodyDark: "#c87840",
        belly: "#f0e0c0",
        ear: "#c87840",
        eye: "#2a6020",
        nose: "#e08090",
        stripe: "#2a2a2a",
      };
    case "siamese":
      return {
        body: "#e8d8c8",
        bodyDark: "#c8b8a8",
        belly: "#f0e8e0",
        ear: "#4a3828",
        eye: "#4a8cc8",
        nose: "#c08090",
        mask: "#4a3828",
      };
    case "british":
      return { body: "#98a0a8", bodyDark: "#687078", belly: "#b8c0c8", ear: "#687078", eye: "#d8c040", nose: "#e0a0b0" };
    case "tuxedo":
      return {
        body: "#2a2a32",
        bodyDark: "#1a1a22",
        belly: "#e8e4dc",
        ear: "#1a1a22",
        eye: "#90d8f0",
        nose: "#e8a0b0",
        stripe: "#e8e4dc",
      };
    case "ginger":
      return { body: "#e8a050", bodyDark: "#c87828", belly: "#f0c878", ear: "#c87828", eye: "#2a6020", nose: "#f0a0a8" };
    case "tabby":
    default:
      return {
        body: "#d89050",
        bodyDark: "#a86830",
        belly: "#f0c890",
        ear: "#a86830",
        eye: "#2a6828",
        nose: "#f0a0a8",
        stripe: "#8a5028",
      };
  }
}
