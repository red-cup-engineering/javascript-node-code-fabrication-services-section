/**
 * Project JSON Schema documents into TypeScript declarations.  The projection
 * intentionally omits constraints TypeScript cannot express; runtime
 * admission remains the schema consumer's responsibility.
 */

const isSchema = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Exported names are emitted into TypeScript and/or executable JavaScript.
// A textual identifier spelling is insufficient: keywords cannot be bindings.
const reserved = new Set([
  "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "yield", "let", "static", "implements", "interface",
  "package", "private", "protected", "public", "arguments", "eval",
  "as", "asserts", "infer", "is", "keyof", "module", "namespace",
  "number", "object", "readonly", "require", "satisfies", "string",
  "symbol", "type", "unique", "unknown", "never", "any", "boolean",
]);
const legalIdentifier = value => typeof value === "string" &&
  /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) && !reserved.has(value);
function identifier(value, label) {
  if (!legalIdentifier(value))
    throw new TypeError(`${label} must be a non-reserved TypeScript/JavaScript identifier`);
  return value;
}
const quoted = (value) => JSON.stringify(value);
function renderTypeName(type) {
  switch (type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return "readonly unknown[]";
    case "object": return "Record<string, unknown>";
    default: return "unknown";
  }
}
function renderTuple(items, minimumItems, tail, root, references, base, active) {
  // A closed tuple shorter than its required minimum describes no values.
  if (tail === false && Number.isInteger(minimumItems) && minimumItems > items.length) return "never";
  const required = Math.max(0, Math.min(items.length, Number.isInteger(minimumItems) ? minimumItems : 0));
  const member = (schema) => { const value = renderSchema(schema, root, references, base, active); return value.includes(" | ") || value.includes(" & ") ? `(${value})` : value; };
  const prefix = items.map((item, index) => `${member(item)}${index < required ? "" : "?"}`);
  const suffix = tail === false ? "" : `${prefix.length === 0 ? "" : ", "}...${member(tail ?? true)}[]`;
  return `readonly [${prefix.join(", ")}${suffix}]`;
}
function resolvedBase(schema, inheritedBase = "") {
  if (!isSchema(schema) || typeof schema.$id !== "string" || schema.$id === "") return inheritedBase;
  try { return new URL(schema.$id, inheritedBase).href; } catch { return schema.$id; }
}
function resolveReference(reference, root, references, base = resolvedBase(root)) {
  if (reference.startsWith("#")) return { schema: root, fragment: reference, local: true };
  const marker = reference.indexOf("#");
  const id = marker === -1 ? reference : reference.slice(0, marker);
  const fragment = marker === -1 ? "" : reference.slice(marker + 1);
  let resolved = id;
  try { resolved = new URL(id, base).href; } catch {}
  const entry = references.find((candidate) => candidate.schema.$id === id || candidate.schema.$id === resolved || candidate.aliases.includes(id) || candidate.aliases.includes(resolved));
  return entry === undefined ? undefined : { schema: entry.schema, fragment: fragment === "" ? "" : `#${fragment}`, local: false, entry };
}
// URI fragments contain RFC 6901 JSON Pointers. Array positions are valid
// pointer segments and percent-encoding/escaped tokens are decoded exactly;
// inherited properties (including __proto__) never belong to a JSON Schema.
function atPointer(schema, fragment) {
  if (fragment === "" || fragment === "#") return schema;
  if (!fragment.startsWith("#/")) return undefined;
  let tokens;
  try { tokens = decodeURIComponent(fragment.slice(2)).split("/").map(token =>
    token.replaceAll("~1", "/").replaceAll("~0", "~")); }
  catch { return undefined; }
  let value = schema;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return undefined;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= value.length) return undefined;
      value = value[index];
    } else if (isSchema(value) && Object.hasOwn(value, token)) {
      value = value[token];
    } else return undefined;
  }
  return value;
}
/**
 * An executable generated schema binding may not silently weaken a missing
 * referenced specification to an unconstrained type. Walk only JSON Schema
 * assertion locations: a $ref inside const, default, or examples is data.
 *
 * This is a source-closure check, not proof that the referenced schemas are
 * institutionally authorized or that generated TypeScript admits all values.
 */
function assertCompleteRuntimeReferences(schema, references) {
  const seen = new WeakSet();
  const single = [
    "additionalItems", "additionalProperties", "contains", "contentSchema",
    "else", "if", "items", "not", "propertyNames", "then",
    "unevaluatedItems", "unevaluatedProperties",
  ];
  const arrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
  const maps = [
    "$defs", "definitions", "dependentSchemas", "dependencies",
    "patternProperties", "properties",
  ];
  const visit = (value, root, inheritedBase) => {
    if (!isSchema(value) || seen.has(value)) return;
    seen.add(value);
    // $dynamicRef (2020-12) and $recursiveRef (2019-09) select their targets
    // using the runtime dynamic evaluation scope, not only a static $ref
    // lookup. This producer has only a static source-closure witness. Do not
    // call the emitted validator source-complete without an independently
    // qualified dynamic-scope resolver at the correct Code owner.
    if (Object.hasOwn(value, "$dynamicRef") || Object.hasOwn(value, "$recursiveRef"))
      throw new TypeError("dynamic runtime JSON Schema reference requires qualified dynamic-scope resolution");
    const base = resolvedBase(value, inheritedBase);
    if (typeof value.$ref === "string") {
      const resolved = resolveReference(value.$ref, root, references, base);
      const target = resolved === undefined
        ? undefined
        : atPointer(resolved.schema, resolved.fragment);
      // A pointer to an existing scalar, array or null is not a valid schema.
      // JSON Schema's two Boolean forms remain legitimate referenced targets.
      if (target === undefined || (target !== true && target !== false && !isSchema(target)))
        throw new TypeError("unresolved runtime JSON Schema reference: " + value.$ref +
          (target === undefined ? "" : " (target is not a schema)"));
      visit(target, resolved.schema, resolvedBase(resolved.schema));
    }
    for (const key of single) visit(value[key], root, base);
    for (const key of arrays) {
      if (Array.isArray(value[key])) for (const item of value[key]) visit(item, root, base);
    }
    for (const key of maps) {
      if (isSchema(value[key]))
        for (const item of Object.values(value[key])) visit(item, root, base);
    }
    if (Array.isArray(value.items))
      for (const item of value.items) visit(item, root, base);
  };
  visit(schema, schema, resolvedBase(schema));
}

function renderSchema(schema, root, references = [], inheritedBase = resolvedBase(root), active = new Set()) {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (!isSchema(schema)) return "unknown";
  // A reference cycle that has no named TypeScript alias is not representable
  // by recursive inline expansion. Refuse rather than emit 'unknown', recurse
  // forever or silently weaken a mathematical contract.
  if (active.has(schema)) throw new TypeError("recursive schema reference needs a named $defs or external type alias");
  const nextActive = new Set(active);
  nextActive.add(schema);
  const base = resolvedBase(schema, inheritedBase);
  if (Array.isArray(schema.allOf)) { const { allOf, ...local } = schema; return [local, ...allOf].map((part) => `(${renderSchema(part, root, references, base, nextActive)})`).join(" & "); }
  if (typeof schema.$ref === "string") {
    const resolved = resolveReference(schema.$ref, root, references, base);
    const local = /^#\/\$defs\/([A-Za-z_$][A-Za-z0-9_$]*)$/u.exec(schema.$ref);
    if (local && legalIdentifier(local[1]) && resolved?.local && isSchema(root.$defs) && Object.hasOwn(root.$defs, local[1])) return local[1];
    const target = resolved === undefined ? undefined : atPointer(resolved.schema, resolved.fragment);
    if (target === undefined) {
      if (resolved?.local) throw new TypeError("unresolved local JSON Schema reference: " + schema.$ref);
      return "unknown"; // Preserve documented lossy behavior for absent external schemas.
    }
    if (resolved.fragment === "" && resolved.entry?.internal !== true) return resolved.entry.typeName;
    return renderSchema(target, resolved.schema, references, resolvedBase(resolved.schema), nextActive);
  }
  if (Object.hasOwn(schema, "const")) return quoted(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(quoted).join(" | ") || "never";
  for (const keyword of ["anyOf", "oneOf"]) if (Array.isArray(schema[keyword])) return schema[keyword].map((member) => renderSchema(member, root, references, base, nextActive)).join(" | ") || "never";
  if (schema.type === "object") {
    if (!isSchema(schema.properties)) return "Record<string, unknown>";
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : []);
    const properties = Object.entries(schema.properties).map(([key, value]) => `readonly ${quoted(key)}${required.has(key) ? "" : "?"}: ${renderSchema(value, root, references, base, nextActive)};`);
    return properties.length === 0 ? "{}" : `{ ${properties.join(" ")} }`;
  }
  if (schema.type === "array") {
    if (Array.isArray(schema.prefixItems)) return renderTuple(schema.prefixItems, schema.minItems, schema.items ?? true, root, references, base, nextActive);
    if (Array.isArray(schema.items)) return renderTuple(schema.items, schema.minItems, schema.additionalItems ?? true, root, references, base, nextActive);
    if (schema.items === false) return schema.minItems > 0 ? "never" : "readonly []";
    const item = renderSchema(schema.items ?? true, root, references, base, nextActive);
    return `readonly ${item.includes(" | ") || item.includes(" & ") ? `(${item})` : item}[]`;
  }
  if (Array.isArray(schema.type)) return schema.type.map(kind =>
    kind === "null" ? "null" : renderSchema({ ...schema, type: kind },
      root, references, base, nextActive)).join(" | ") || "unknown";
  return renderTypeName(schema.type);
}

export function transformJsonSchemaToTypescript(schema, options = {}) {
  if (schema !== true && schema !== false && !isSchema(schema)) throw new TypeError("schema must be a JSON Schema object or boolean");
  if (!isSchema(options)) throw new TypeError("options must be an object");
  const typeName = identifier(options.typeName ?? (isSchema(schema) && typeof schema.title === "string" ? schema.title : "Schema"), "typeName");
  const references = Array.isArray(options.references) ? options.references : [];
  const definitions = isSchema(schema) && isSchema(schema.$defs) ? Object.entries(schema.$defs) : [];
  // JSON Schema definition names are arbitrary JSON strings, including slashes
  // and tildes. Only safe identifiers can be TS aliases; the rest are inlined.
  const aliasDefinitions = definitions.filter(([name]) => legalIdentifier(name));
  if (aliasDefinitions.some(([name]) => name === typeName))
    throw new TypeError("duplicate TypeScript typeName and $defs alias: " + typeName);
  const aliases = aliasDefinitions.map(([name, definition]) =>
    `export type ${name} = ${renderSchema(definition, schema, references)};`);
  return [...aliases, `export type ${typeName} = ${renderSchema(schema, schema, references)};`, ""].join("\n");
}

function schemaLiteralType(value) {
  if (Array.isArray(value)) return `readonly [${value.map(schemaLiteralType).join(", ")}]`;
  if (isSchema(value)) return `{ ${Object.entries(value).map(([key, item]) => `readonly ${quoted(key)}: ${schemaLiteralType(item)};`).join(" ")} }`;
  return quoted(value);
}

/** Derive runtime ESM and declarations from the same schema entries.
 * The default TypeScript module remains available for existing generation consumers. */
export function renderJsonSchemaModule(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("entries must be a nonempty array");
  if (!isSchema(options)) throw new TypeError("options must be an object");
  const format = options.format ?? "typescript";
  if (!["typescript", "javascript", "declaration"].includes(format)) throw new TypeError("format must be typescript, javascript, or declaration");
  const runtimeBinding = options.runtimeBinding === undefined ? undefined : options.runtimeBinding;
  if (runtimeBinding !== undefined && (!isSchema(runtimeBinding) || typeof runtimeBinding.from !== "string" || runtimeBinding.from === ""))
    throw new TypeError("runtimeBinding must name an import");
  if (runtimeBinding !== undefined) identifier(runtimeBinding.name, "runtimeBinding.name");
  // A generated JavaScript schema must preserve nested source constraints. A
  // shallow Object.freeze let an installed consumer rewrite conformance and
  // authorization claims while leaving the outer schema deceptively frozen.
  // This source-private emitted helper is shared by all generated JS entries.
  const freezer = "__freezeGeneratedSchema";
  if (format === "javascript" && runtimeBinding?.name === freezer)
    throw new TypeError("runtimeBinding.name collides with generated schema freezer");
  const names = new Set([
    ...(runtimeBinding === undefined ? [] : [runtimeBinding.name]),
    ...(format === "javascript" ? [freezer] : []),
  ]);
  const typeNames = new Set();
  const ordered = [...entries].map((entry) => {
    if (!isSchema(entry) || !isSchema(entry.schema)) throw new TypeError("each entry must contain a schema object");
    const exportName = identifier(entry.exportName, "exportName");
    if (names.has(exportName)) throw new TypeError(`duplicate generated JavaScript binding ${exportName}`);
    names.add(exportName);
    const runtimeName = entry.runtimeName === undefined ? undefined : identifier(entry.runtimeName, "runtimeName");
    if (runtimeName !== undefined) {
      if (names.has(runtimeName)) throw new TypeError(`duplicate generated JavaScript binding ${runtimeName}`);
      names.add(runtimeName);
    }
    const typeName = identifier(entry.typeName, "typeName");
    const localAliases = isSchema(entry.schema.$defs) ? Object.keys(entry.schema.$defs).filter(legalIdentifier) : [];
    for (const type of [typeName, ...localAliases]) {
      if (typeNames.has(type)) throw new TypeError(`duplicate generated TypeScript type ${type}`);
      typeNames.add(type);
    }
    const aliases = entry.aliases === undefined ? [] : entry.aliases;
    if (!Array.isArray(aliases) || !aliases.every((name) => typeof name === "string")) throw new TypeError("aliases must contain strings");
    if (runtimeName !== undefined && runtimeBinding === undefined) throw new TypeError("runtimeName requires runtimeBinding");
    return { exportName, typeName, schema: entry.schema, runtimeName, aliases, internal: entry.internal === true };
  }).sort((left, right) => left.exportName.localeCompare(right.exportName));
  // Runtime generation must close every source reference; declarations alone
  // retain their explicitly lossy TypeScript projection for legacy callers.
  for (const entry of ordered) {
    if (entry.runtimeName !== undefined)
      assertCompleteRuntimeReferences(entry.schema, ordered);
  }
  const runtimeReferences = (entry) => {
    const found = new Set();
    const visitedEntries = new Set();
    const visit = (value, root, inheritedBase) => {
      if (!isSchema(value)) return;
      const base = resolvedBase(value, inheritedBase);
      if (typeof value.$ref === "string") {
        const candidate = resolveReference(value.$ref, root, ordered, base)?.entry;
        if (candidate && candidate !== entry) {
          found.add(candidate.exportName);
          visitEntry(candidate);
        }
      }
      for (const key of ["additionalItems", "additionalProperties", "contains", "contentSchema", "else", "if", "items", "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties"]) visit(value[key], root, base);
      for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) if (Array.isArray(value[key])) for (const child of value[key]) visit(child, root, base);
      for (const key of ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]) if (isSchema(value[key])) for (const child of Object.values(value[key])) visit(child, root, base);
      if (Array.isArray(value.items)) for (const child of value.items) visit(child, root, base);
      if (isSchema(value.dependencies)) for (const child of Object.values(value.dependencies)) visit(child, root, base);
    };
    const visitEntry = (candidate) => {
      if (visitedEntries.has(candidate)) return;
      visitedEntries.add(candidate);
      visit(candidate.schema, candidate.schema, resolvedBase(candidate.schema));
    };
    visitEntry(entry);
    return [...found].sort();
  };
  return [
    "/** Generated from specifications/*.schema.json. Do not edit. */",
    runtimeBinding === undefined ? undefined : `import ${format === "declaration" ? "type " : ""}{ ${runtimeBinding.name} } from ${quoted(runtimeBinding.from)};`,
    format === "javascript" ? [
      "const __freezeGeneratedSchema = value => {",
      "  if (value !== null && typeof value === \"object\") {",
      "    for (const child of Object.values(value)) __freezeGeneratedSchema(child);",
      "    Object.freeze(value);",
      "  }",
      "  return value;",
      "};",
    ].join("\n") : undefined,
    ...ordered.flatMap(({ exportName, typeName, schema, internal }) => [
      format === "javascript" ? undefined : transformJsonSchemaToTypescript(schema, { typeName, references: ordered }),
      format === "declaration"
        ? `${internal ? "" : "export "}declare const ${exportName}: ${schemaLiteralType(schema)};`
        : format === "javascript"
          // Parse strict JSON instead of embedding an object literal: properties
          // named "__proto__" remain real own JSON members, not prototype setters.
          // The emitted helper seals every nested schema, rule list and example.
          ? `${internal ? "const" : "export const"} ${exportName} = __freezeGeneratedSchema(JSON.parse(${JSON.stringify(JSON.stringify(schema))}));`
          : `${internal ? "const" : "export const"} ${exportName} = Object.freeze(${JSON.stringify(schema, null, 2)} as const);`,
      "",
    ]),
    ...ordered.map((entry) => entry.runtimeName === undefined ? undefined : format === "declaration"
      ? `export declare const ${entry.runtimeName}: ReturnType<typeof ${runtimeBinding.name}${runtimeBinding.genericSchema === true ? `<typeof ${entry.exportName}>` : ""}>;`
      : `export const ${entry.runtimeName} = ${runtimeBinding.name}(${entry.exportName}${runtimeReferences(entry).length === 0 ? "" : `, [${runtimeReferences(entry).join(", ")}]`});`),
  ].filter((line) => line !== undefined).join("\n");
}
