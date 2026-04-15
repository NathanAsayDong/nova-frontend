export function HudBackground() {
  return (
    <>
      <div className="hudNoise" aria-hidden="true" />
      <div className="hudGrid" aria-hidden="true">
        <span className="hudPanel hudPanelTopLeft" />
        <span className="hudPanel hudPanelTopRight" />
        <span className="hudPanel hudPanelMidLeft" />
        <span className="hudPanel hudPanelMidRight" />
        <span className="hudPanel hudPanelBottomLeft" />
        <span className="hudPanel hudPanelBottomRight" />
      </div>
    </>
  )
}
