import { describe, it, expect } from 'vitest'
import { smallFleetCameraZ, SMALL_FLEET_CAMERA_Z } from '../src/lib/graph'

describe('smallFleetCameraZ (DF-2)', () => {
  it('clamps the camera for 1- and 2-node fleets', () => {
    expect(smallFleetCameraZ(1)).toBe(SMALL_FLEET_CAMERA_Z)
    expect(smallFleetCameraZ(2)).toBe(SMALL_FLEET_CAMERA_Z)
  })
  it('defers to zoomToFit for 0 and >=3 nodes', () => {
    expect(smallFleetCameraZ(0)).toBeNull()
    expect(smallFleetCameraZ(3)).toBeNull()
    expect(smallFleetCameraZ(30)).toBeNull()
  })
})
