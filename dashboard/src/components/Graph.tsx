import cytoscape, { type Core } from "cytoscape"
import { useEffect, useRef } from "react"
import type { GraphData } from "../api"

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Institution - recipient graph of all cases on the board; red = part of a flagged case. */
export function Graph({ data, onCase }: { data: GraphData; onCase: (id: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const text = css("--text")
    const faint = css("--faint")
    const risk = css("--risk")
    const accent = css("--accent")
    const border = css("--border")
    cy.current = cytoscape({
      container: ref.current,
      wheelSensitivity: 0.2,
      style: [
        { selector: "node", style: { label: "data(label)", "font-size": 9, color: text, "text-wrap": "ellipsis", "text-max-width": "110px", "background-color": faint, width: 14, height: 14 } },
        { selector: 'node[type = "payer"]', style: { shape: "round-rectangle", "background-color": accent, width: 18, height: 18 } },
        { selector: "node[?flagged]", style: { "background-color": risk } },
        { selector: 'node[type = "payer"][?flagged]', style: { "border-width": 2, "border-color": accent } },
        { selector: "edge", style: { width: "mapData(amount, 0, 20000000, 1, 7)", "line-color": border, "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": border, "arrow-scale": 0.6 } },
        { selector: "edge[?flagged]", style: { "line-color": risk, "target-arrow-color": risk, opacity: 0.8 } },
      ],
    })
    cy.current.on("tap", "edge", (e) => {
      const cases = e.target.data("cases") as number[]
      if (cases?.length) onCase(cases[0])
    })
    return () => cy.current?.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const c = cy.current
    if (!c) return
    c.elements().remove()
    c.add([
      ...data.nodes.map((n) => ({ data: { ...n } })),
      ...data.edges.map((e) => ({ data: { ...e } })),
    ])
    c.layout({ name: "cose", animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 60, padding: 20 } as cytoscape.LayoutOptions).run()
  }, [data])

  return <div ref={ref} className="graph" />
}
