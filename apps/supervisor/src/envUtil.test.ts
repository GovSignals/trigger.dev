import { describe, it, expect } from "vitest";
import { z } from "zod";
import { BoolEnv, AdditionalEnvVars, JsonObjectEnv, JsonAny } from "./envUtil.js";

describe("BoolEnv", () => {
  it("should parse string 'true' as true", () => {
    expect(BoolEnv.parse("true")).toBe(true);
    expect(BoolEnv.parse("TRUE")).toBe(true);
    expect(BoolEnv.parse("True")).toBe(true);
  });

  it("should parse string '1' as true", () => {
    expect(BoolEnv.parse("1")).toBe(true);
  });

  it("should parse string 'false' as false", () => {
    expect(BoolEnv.parse("false")).toBe(false);
    expect(BoolEnv.parse("FALSE")).toBe(false);
    expect(BoolEnv.parse("False")).toBe(false);
  });

  it("should handle whitespace", () => {
    expect(BoolEnv.parse(" true ")).toBe(true);
    expect(BoolEnv.parse(" 1 ")).toBe(true);
  });

  it("should pass through boolean values", () => {
    expect(BoolEnv.parse(true)).toBe(true);
    expect(BoolEnv.parse(false)).toBe(false);
  });

  it("should return false for invalid inputs", () => {
    expect(BoolEnv.parse("invalid")).toBe(false);
    expect(BoolEnv.parse("")).toBe(false);
  });
});

describe("AdditionalEnvVars", () => {
  it("should parse single key-value pair", () => {
    expect(AdditionalEnvVars.parse("FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("should parse multiple key-value pairs", () => {
    expect(AdditionalEnvVars.parse("FOO=bar,BAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should handle whitespace", () => {
    expect(AdditionalEnvVars.parse(" FOO = bar , BAZ = qux ")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should return undefined for empty string", () => {
    expect(AdditionalEnvVars.parse("")).toBeUndefined();
  });

  it("should return undefined for invalid format", () => {
    expect(AdditionalEnvVars.parse("invalid")).toBeUndefined();
  });

  it("should skip invalid pairs but include valid ones", () => {
    expect(AdditionalEnvVars.parse("FOO=bar,INVALID,BAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("should pass through undefined", () => {
    expect(AdditionalEnvVars.parse(undefined)).toBeUndefined();
  });

  it("should handle empty values", () => {
    expect(AdditionalEnvVars.parse("FOO=,BAR=value")).toEqual({
      BAR: "value",
    });
  });
});

describe("JsonObjectEnv (string-valued)", () => {
  const schema = JsonObjectEnv("TEST_ENV");

  it("returns empty object for default (no value)", () => {
    expect(schema.parse(undefined)).toEqual({});
  });

  it("parses a simple string-valued JSON object", () => {
    expect(schema.parse('{"a":"1","b":"2"}')).toEqual({ a: "1", b: "2" });
  });

  it("parses an empty JSON object", () => {
    expect(schema.parse("{}")).toEqual({});
  });

  it("rejects non-JSON input", () => {
    expect(() => schema.parse("not json")).toThrowError(/not valid JSON/);
  });

  it("rejects JSON arrays", () => {
    expect(() => schema.parse("[]")).toThrowError(/must be a JSON object \(got array\)/);
  });

  it("rejects JSON primitives", () => {
    expect(() => schema.parse('"foo"')).toThrowError(/must be a JSON object \(got string\)/);
    expect(() => schema.parse("42")).toThrowError(/must be a JSON object \(got number\)/);
    expect(() => schema.parse("null")).toThrowError(/must be a JSON object \(got object\)/);
  });

  it("rejects values that are not strings (with default validator)", () => {
    expect(() => schema.parse('{"a": 1}')).toThrowError(/has invalid value/);
    expect(() => schema.parse('{"a": true}')).toThrowError(/has invalid value/);
  });
});

describe("JsonObjectEnv (arbitrary-value)", () => {
  const schema = JsonObjectEnv("TEST_ANY", { valueValidator: JsonAny });

  it("accepts nested objects", () => {
    expect(
      schema.parse(
        JSON.stringify({
          runAsNonRoot: true,
          runAsUser: 1000,
          capabilities: { drop: ["ALL"] },
        })
      )
    ).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("accepts mixed value types", () => {
    expect(schema.parse('{"s":"x","n":1,"b":true,"a":[1,2],"o":{"k":"v"}}')).toEqual({
      s: "x",
      n: 1,
      b: true,
      a: [1, 2],
      o: { k: "v" },
    });
  });

  it("still rejects non-object roots", () => {
    expect(() => schema.parse('"x"')).toThrowError(/must be a JSON object/);
    expect(() => schema.parse("[1,2,3]")).toThrowError(/must be a JSON object/);
  });

  it("includes the env var name in error messages", () => {
    const named = JsonObjectEnv("KUBERNETES_WORKER_POD_SECURITY_CONTEXT");
    expect(() => named.parse("{notjson")).toThrowError(/KUBERNETES_WORKER_POD_SECURITY_CONTEXT/);
  });
});

describe("JsonObjectEnv (flat string values, K8s-annotation shape)", () => {
  // Regression test for a real production incident on FedStart: passing
  // KUBERNETES_WORKER_POD_ANNOTATIONS with a nested-map value silently
  // passed zod validation under the default JsonStringMap validator
  // (because `{}` is a valid empty `Record<string,string>`), but then
  // got spread directly into a K8s Pod's metadata.annotations and
  // rejected by the apiserver:
  //
  //   "Pod in version v1 cannot be handled as a Pod: json: cannot
  //    unmarshal object into Go struct field
  //    ObjectMeta.metadata.annotations of type string"
  //
  // K8s annotations are flat `map[string]string` per the API spec, so
  // KUBERNETES_WORKER_POD_ANNOTATIONS must validate values as `z.string()`,
  // not as a nested string map.
  const schema = JsonObjectEnv("KUBERNETES_WORKER_POD_ANNOTATIONS", {
    valueValidator: z.string(),
  });

  it("accepts the Rubix pod-cert annotation as a string value", () => {
    // Rubix's `com.palantir.rubix.service/pod-cert` annotation expects
    // its VALUE to be the 2-char string "{}" (which Rubix internally
    // parses as JSON to determine cert minting config). The env var
    // input is itself JSON-stringified, so the value here is the
    // 4-char string `"{}"` — two quotes around two braces.
    expect(schema.parse('{"com.palantir.rubix.service/pod-cert":"{}"}')).toEqual({
      "com.palantir.rubix.service/pod-cert": "{}",
    });
  });

  it("accepts multiple flat string annotations", () => {
    expect(
      schema.parse('{"com.palantir.rubix.service/pod-cert":"{}","trigger.dev/owner":"supervisor"}')
    ).toEqual({
      "com.palantir.rubix.service/pod-cert": "{}",
      "trigger.dev/owner": "supervisor",
    });
  });

  it("rejects object values (annotations must be flat strings)", () => {
    // The pre-fix bug: this would have passed zod with the default
    // JsonStringMap validator, then crashed at K8s apiserver. Schema
    // must reject before the value ever reaches K8s.
    expect(() => schema.parse('{"com.palantir.rubix.service/pod-cert":{}}')).toThrowError(
      /has invalid value/
    );
  });

  it("rejects nested string maps as values", () => {
    expect(() => schema.parse('{"some/annotation":{"nested":"value"}}')).toThrowError(
      /has invalid value/
    );
  });

  it("rejects numeric and boolean values", () => {
    expect(() => schema.parse('{"some/annotation":42}')).toThrowError(/has invalid value/);
    expect(() => schema.parse('{"some/annotation":true}')).toThrowError(/has invalid value/);
  });
});
