import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  renderJsonSchemaModule, transformJsonSchemaToTypescript,
} from "../scripts/transform-json-schema-to-typescript.mjs";

const runtimeBinding = { name: "defineSchemaType", from: "./schema-type.mjs" };
const evidence = {
  exportName: "evidenceSchema", typeName: "EvidenceEnvelope",
  schema: {
    $id: "https://schemas.561.group/process/evidence.json",
    $defs: {
      Evidence: {
        type: "object",
        required: ["digest"],
        properties: { digest: { type: "string", minLength: 1 } },
      },
    },
    type: "object",
  },
};
const design = (pointer = "evidence.json#/$defs/Evidence") => ({
  exportName: "designSchema", typeName: "Design",
  runtimeName: "designType",
  schema: {
    $id: "https://schemas.561.group/process/design.json",
    type: "object",
    required: ["evidence"],
    properties: {
      evidence: { $ref: pointer },
    },
  },
});

test("generated runtime carriers retain resolved external design evidence", () => {
  const entries = [design(), evidence];
  const output = renderJsonSchemaModule(entries, {
    format: "javascript", runtimeBinding,
  });
  assert.match(output, /designType = defineSchemaType\(designSchema, \[evidenceSchema\]\)/u);
  assert.equal(output, renderJsonSchemaModule([...entries].reverse(), {
    format: "javascript", runtimeBinding,
  }), "stable output under reordering");
});

test("executable generation refuses an unresolved external design reference", () => {
  const missing = [design("absent.json#/$defs/Proof"), evidence];
  for (const format of ["javascript", "typescript", "declaration"]) {
    assert.throws(() => renderJsonSchemaModule(missing, {
      format, runtimeBinding,
    }), /unresolved runtime JSON Schema reference: absent\.json/u);
  }
  const legacy = transformJsonSchemaToTypescript(missing[0].schema, {
    typeName: "Design",
  });
  assert.match(legacy, /"evidence": unknown;/u,
    "standalone declaration is explicitly lossy, not falsely certified");
});

test("a known document with an absent internal pointer still refuses", () => {
  assert.throws(() => renderJsonSchemaModule([
    design("evidence.json#/$defs/Missing"), evidence,
  ], { format: "javascript", runtimeBinding }),
  /unresolved runtime JSON Schema reference/u);
});

test("nested specification choices and transitive references are checked", () => {
  const root = design();
  root.schema.if = { properties: {
    privileged: { $ref: "absent.json#/$defs/Permission" },
  } };
  assert.throws(() => renderJsonSchemaModule([root, evidence], {
    format: "javascript", runtimeBinding,
  }), /unresolved runtime JSON Schema reference/u);
  const indirect = {
    ...evidence,
    schema: {
      ...evidence.schema,
      $defs: {
        Evidence: { $ref: "other.json#/$defs/Signature" },
      },
    },
  };
  assert.throws(() => renderJsonSchemaModule([design(), indirect], {
    format: "javascript", runtimeBinding,
  }), /unresolved runtime JSON Schema reference/u);
});

test("example content is not confused with a reference constraint", () => {
  const source = design();
  source.schema.examples = [{ $ref: "this-is-data.json" }];
  const output = renderJsonSchemaModule([source, evidence], {
    format: "javascript", runtimeBinding,
  });
  assert.match(output, /designType = defineSchemaType/u);
});

test("changed design deterministically regenerates different executable source", () => {
  const before = renderJsonSchemaModule([design(), evidence], {
    format: "javascript", runtimeBinding,
  });
  const revised = design();
  revised.schema.properties.extra = { type: "boolean" };
  const after = renderJsonSchemaModule([revised, evidence], {
    format: "javascript", runtimeBinding,
  });
  assert.notEqual(after, before);
  assert.equal(after, renderJsonSchemaModule([revised, evidence], {
    format: "javascript", runtimeBinding,
  }));
});

test("runtime generation rejects references to present but nonschema source values", () => {
  for (const malformed of [null, 17, "not a schema", [], ["object"]]) {
    const input = design("#/$defs/not-a-schema");
    input.schema.$defs = { "not-a-schema": malformed };
    assert.throws(() => renderJsonSchemaModule([input], {
      format: "javascript", runtimeBinding,
    }), /unresolved runtime JSON Schema reference: .*target is not a schema/u);
  }
});

test("boolean true and false remain legitimate referenced JSON Schemas", () => {
  for (const [value, declared] of [[true, "unknown"], [false, "never"]]) {
    const input = design("#/$defs/boolean-schema");
    input.schema.$defs = { "boolean-schema": value };
    // Type declarations expose the projected alias; JS-only output has none.
    const result = renderJsonSchemaModule([input], {
      format: "typescript", runtimeBinding,
    });
    assert.match(result, new RegExp('"evidence": ' + declared + ';', "u"));
  }
});

test("generated native JavaScript keeps all nested source rules immutable",async()=>{
  const schema={
    type:"object",
    required:["standing"],
    properties:{
      standing:{const:"unassessed"},
      evidence:{type:"array",items:{type:"object",properties:{
        verdict:{enum:["held","unknown","denied"]}
      }}}
    }
  };
  const output=renderJsonSchemaModule([
    {exportName:"standingSchema",typeName:"Standing",schema}
  ],{format:"javascript"});
  const module=await import("data:text/javascript;base64,"+Buffer.from(output).toString("base64"));
  const received=module.standingSchema;
  assert.deepEqual(received,schema);
  const refs=[received,received.required,received.properties,
    received.properties.standing,received.properties.evidence,
    received.properties.evidence.items,
    received.properties.evidence.items.properties.verdict.enum];
  assert.ok(refs.every(Object.isFrozen),"deeply immutable source, not one frozen outer wrapper");
  assert.throws(()=>{received.properties.standing.const="certified";},TypeError);
  assert.throws(()=>{received.properties.evidence.items.properties.verdict.enum.push("fabricated");},TypeError);
  assert.equal(received.properties.standing.const,"unassessed");
  assert.equal(output,renderJsonSchemaModule([
    {exportName:"standingSchema",typeName:"Standing",schema}
  ],{format:"javascript"}));
});

test("generated JS preserves every exact JSON source key, including __proto__, without prototype mutation",async()=>{
  const schema=JSON.parse('{"__proto__":{"const":"source-data"},"properties":{"__proto__":{"type":"number"},"safe":{"type":"integer"}}}');
  const output=renderJsonSchemaModule([{exportName:"safeSchema",typeName:"Safe",schema}],{format:"javascript"});
  const runtime=await import("data:text/javascript;base64,"+Buffer.from(output).toString("base64"));
  assert.deepEqual(runtime.safeSchema,schema);
  assert.equal(Object.getPrototypeOf(runtime.safeSchema),Object.prototype);
  assert.equal(Object.getPrototypeOf(runtime.safeSchema.properties),Object.prototype);
  assert.equal(Object.hasOwn(runtime.safeSchema,"__proto__"),true);
  assert.equal(Object.hasOwn(runtime.safeSchema.properties,"__proto__"),true);
  assert.equal(Object.isFrozen(runtime.safeSchema.__proto__),true);
  assert.equal(Object.isFrozen(runtime.safeSchema.properties.__proto__),true);
  assert.throws(()=>{runtime.safeSchema.properties.__proto__.type="string";},TypeError);
});

test("one private code-generator helper is shared and cannot impersonate a declared export or import",async()=>{
  const entries=[
    {exportName:"firstSchema",typeName:"First",schema:{type:"object",properties:{x:{const:1}}}},
    {exportName:"secondSchema",typeName:"Second",schema:{type:"object",properties:{y:{const:2}}}}
  ];
  const src=renderJsonSchemaModule(entries,{format:"javascript"});
  assert.equal((src.match(/const __freezeGeneratedSchema =/gu)??[]).length,1);
  const mod=await import("data:text/javascript;base64,"+Buffer.from(src).toString("base64"));
  assert.ok(Object.isFrozen(mod.firstSchema.properties.x));
  assert.ok(Object.isFrozen(mod.secondSchema.properties.y));
  assert.throws(()=>renderJsonSchemaModule([
    {exportName:"__freezeGeneratedSchema",typeName:"A",schema:{type:"object"}}
  ],{format:"javascript"}),/duplicate generated JavaScript binding/u);
  assert.throws(()=>renderJsonSchemaModule(entries,{format:"javascript",
    runtimeBinding:{name:"__freezeGeneratedSchema",from:"./schema-type.mjs"}}),
    /collides with generated schema freezer/u);
});

if(process.env.SPEC_ARCHITECTURE_SCHEMA_FILE){
  test("real merged Specification candidate cannot acquire a manufactured conformance verdict",async()=>{
    const schema=JSON.parse(readFileSync(process.env.SPEC_ARCHITECTURE_SCHEMA_FILE,"utf8"));
    assert.equal(schema.properties.standard.properties.conformance.const,"unassessed");
    assert.equal(schema.$schema,"https://json-schema.org/draft/2020-12/schema");
    const code=renderJsonSchemaModule([{
      exportName:"architectureDescriptionCandidateSchema",
      typeName:"ArchitectureDescriptionCandidate",schema
    }],{format:"javascript"});
    const generated=await import("data:text/javascript;base64,"+Buffer.from(code).toString("base64"));
    const value=generated.architectureDescriptionCandidateSchema;
    assert.deepEqual(value,schema);
    assert.equal(Object.isFrozen(value.properties.standard.properties.conformance),true);
    assert.throws(()=>{value.properties.standard.properties.conformance.const="certified";},TypeError);
    assert.equal(value.properties.standard.properties.conformance.const,"unassessed");
    assert.equal(Object.isFrozen(value.$defs.refs.items),true);
    assert.equal(Object.isFrozen(value.required),true);
    assert.equal(Object.isFrozen(value.properties.system.properties.sourceIds.items),true);
  });
}



test("a runtime binding refuses dynamically scoped 2020-12 references rather than claiming static source closure",()=>{
  const candidate=design();
  candidate.schema.properties.evidence={$dynamicRef:"#original-proof"};
  for(const format of ["javascript","typescript","declaration"]){
    assert.throws(()=>renderJsonSchemaModule([candidate,evidence],{
      format,runtimeBinding,
    }),/dynamic runtime JSON Schema reference requires qualified dynamic-scope resolution/u);
  }
  // A lossy standalone TS projection has no executable runtime binding to
  // certify; do not change the explicitly documented legacy source view.
  const lossy=transformJsonSchemaToTypescript(candidate.schema,{typeName:"Design"});
  assert.match(lossy,/export type Design/u);
});

test("older 2019-09 recursive references require qualified dynamic-scope handling",()=>{
  const candidate=design();
  candidate.schema.properties.evidence={$recursiveRef:"#"};
  assert.throws(()=>renderJsonSchemaModule([candidate,evidence],{
    format:"javascript",runtimeBinding,
  }),/dynamic runtime JSON Schema reference requires qualified dynamic-scope resolution/u);
});

test("a transitive dependency cannot hide a dynamic reference in nested design inputs",()=>{
  const nested={
    ...evidence,
    schema:{...evidence.schema,$defs:{Evidence:{
      type:"object",properties:{acceptance:{$dynamicRef:"#qualified-acceptance"}},
    }}},
  };
  assert.throws(()=>renderJsonSchemaModule([design(),nested],{
    format:"javascript",runtimeBinding,
  }),/dynamic runtime JSON Schema reference requires qualified dynamic-scope resolution/u);
});

test("annotation examples do not become false dynamic-reference constraints",()=>{
  const candidate=design();
  candidate.schema.examples=[{$dynamicRef:"#sample-only"},{$recursiveRef:"#"}];
  candidate.schema.default={$dynamicRef:"#not-an-assertion"};
  const output=renderJsonSchemaModule([candidate,evidence],{
    format:"javascript",runtimeBinding,
  });
  assert.match(output,/designType = defineSchemaType/u);
  const raw=renderJsonSchemaModule([{...candidate,runtimeName:undefined}],{
    format:"javascript",
  });
  assert.match(raw,/\$dynamicRef/u,"literal-only schema still retains its authored bytes");
});
