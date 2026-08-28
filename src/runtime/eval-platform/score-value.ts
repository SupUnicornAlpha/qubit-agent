import type { ScoreDataType, ScoreValue } from "./contracts";

export function numericScore(value: number, comment?: string) {
  return { value: { dataType: "NUMERIC" as const, numeric: value }, ...(comment ? { comment } : {}) };
}

export function booleanScore(value: boolean, comment?: string) {
  return { value: { dataType: "BOOLEAN" as const, boolean: value }, ...(comment ? { comment } : {}) };
}

export function categoricalScore(value: string, comment?: string) {
  return {
    value: { dataType: "CATEGORICAL" as const, categorical: value },
    ...(comment ? { comment } : {}),
  };
}

export function textScore(value: string, comment?: string) {
  return { value: { dataType: "TEXT" as const, text: value }, ...(comment ? { comment } : {}) };
}

export function decodeScoreValue(input: {
  dataType: ScoreDataType;
  valueNumeric: number | null;
  valueCategorical: string | null;
  valueBoolean: boolean | null;
  valueText: string | null;
}): ScoreValue {
  switch (input.dataType) {
    case "NUMERIC":
      return { dataType: "NUMERIC", numeric: input.valueNumeric ?? 0 };
    case "CATEGORICAL":
      return { dataType: "CATEGORICAL", categorical: input.valueCategorical ?? "" };
    case "BOOLEAN":
      return { dataType: "BOOLEAN", boolean: Boolean(input.valueBoolean) };
    case "TEXT":
      return { dataType: "TEXT", text: input.valueText ?? "" };
  }
}

export function encodeScoreColumns(value: ScoreValue): {
  valueNumeric: number | null;
  valueCategorical: string | null;
  valueBoolean: boolean | null;
  valueText: string | null;
} {
  switch (value.dataType) {
    case "NUMERIC":
      return {
        valueNumeric: value.numeric ?? null,
        valueCategorical: null,
        valueBoolean: null,
        valueText: null,
      };
    case "CATEGORICAL":
      return {
        valueNumeric: null,
        valueCategorical: value.categorical ?? null,
        valueBoolean: null,
        valueText: null,
      };
    case "BOOLEAN":
      return {
        valueNumeric: null,
        valueCategorical: null,
        valueBoolean: value.boolean ?? null,
        valueText: null,
      };
    case "TEXT":
      return {
        valueNumeric: null,
        valueCategorical: null,
        valueBoolean: null,
        valueText: value.text ?? null,
      };
  }
}
