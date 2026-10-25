/// <reference types="vite/client" />

// Allow CSS ?inline imports to be typed as string
declare module '*.css?inline' {
  const css: string
  export default css
}
