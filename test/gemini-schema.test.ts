import assert from "node:assert/strict"
import { test } from "node:test"
import { arr, nullable, num, obj, str, toGeminiSchema } from "../src/llm/think.js"

test("Gemini schema drops additionalProperties and null unions", () => {
  const schema = obj({ name: str("n"), price: nullable(num("p")), tags: arr(obj({ t: str() })) })
  const g = JSON.stringify(toGeminiSchema(schema))
  assert.ok(!g.includes("additionalProperties"))
  assert.ok(!g.includes('"null"'))
  const out = toGeminiSchema(schema) as any
  assert.deepEqual(out.properties.price, { type: "number", description: "p", nullable: true })
  assert.deepEqual(out.required, ["name", "price", "tags"])
})
