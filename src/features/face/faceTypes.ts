/** The face's expression states, published by the app tab and rendered at /face. */
export type FaceMode =
  | 'off'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'meeting'

export type FaceEvent =
  | { type: 'face_state'; mode: FaceMode }
  | { type: 'face_level'; level: number }
  | { type: 'pong' }
