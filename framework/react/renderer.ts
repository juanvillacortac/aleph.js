import type { ComponentType, ReactElement } from 'https://esm.sh/react'
import { createElement } from 'https://esm.sh/react'
import { renderToString } from 'https://esm.sh/react-dom/server'
import util from '../../shared/util.ts'
import type { RouterURL } from '../../types.ts'
import events from '../core/events.ts'
import { serverStyles } from "../core/style.ts"
import { RouterContext, SSRContext } from './context.ts'
import { AsyncUseDenoError, E400MissingComponent, E404Page } from './error.ts'
import { isLikelyReactComponent } from './helper.ts'
import { createPageProps } from './pageprops.ts'

type RenderResult = {
  head: string[]
  body: string
  scripts: Record<string, any>[]
  data: Record<string, string> | null
}

export async function render(
  url: RouterURL,
  App: ComponentType<any> | undefined,
  E404: ComponentType | undefined,
  pageComponentChain: { url: string, Component?: any }[]
): Promise<RenderResult> {
  const global = globalThis as any
  const ret: RenderResult = {
    head: [],
    body: '',
    scripts: [],
    data: null,
  }
  const buildMode = Deno.env.get('BUILD_MODE')
  const styleLinks: Map<string, { module: string }> = new Map()
  const headElements: Map<string, { type: string, props: Record<string, any> }> = new Map()
  const scriptElements: Map<string, { props: Record<string, any> }> = new Map()
  const dataUrl = 'data://' + url.pathname
  const asyncCalls: Array<Promise<any>> = []
  const data: Record<string, any> = {}
  const pageProps = createPageProps(pageComponentChain)
  const defer = () => {
    delete global['rendering-' + dataUrl]
    events.removeAllListeners('useDeno-' + dataUrl)
  }

  // rendering data cache
  global['rendering-' + dataUrl] = {}

  // listen `useDeno-*` events to get hooks callback result.
  events.on('useDeno-' + dataUrl, (id: string, v: any) => {
    if (v instanceof Promise) {
      asyncCalls.push(v)
    } else {
      data[id] = v
    }
  })

  let el: ReactElement
  if (App) {
    if (isLikelyReactComponent(App)) {
      el = createElement(App, pageProps)
    } else {
      el = createElement(E400MissingComponent, { name: 'Custom App' })
    }
  } else {
    if (pageProps.Page == null) {
      if (E404) {
        if (isLikelyReactComponent(E404)) {
          el = createElement(E404)
        } else {
          el = createElement(E400MissingComponent, { name: 'Custom 404' })
        }
      } else {
        el = createElement(E404Page)
      }
    } else {
      el = createElement(pageProps.Page, pageProps.pageProps)
    }
  }

  // `renderToString` might be invoked repeatedly when asyncchronous callbacks exist.
  while (true) {
    try {
      if (asyncCalls.length > 0) {
        await Promise.all(asyncCalls.splice(0, asyncCalls.length))
      }
      ret.body = renderToString(createElement(
        SSRContext.Provider,
        { value: { styleLinks, headElements, scriptElements } },
        createElement(
          RouterContext.Provider,
          { value: url },
          el
        )
      ))
      if (Object.keys(data).length > 0) {
        ret.data = data
      }
      break
    } catch (error) {
      if (error instanceof AsyncUseDenoError) {
        continue
      }

      defer()
      throw error
    }
  }

  // get head child tags
  headElements.forEach(({ type, props }) => {
    const { children, ...rest } = props
    if (type === 'title') {
      if (util.isNEString(children)) {
        ret.head.push(`<title ssr>${children}</title>`)
      } else if (util.isNEArray(children)) {
        ret.head.push(`<title ssr>${children.join('')}</title>`)
      }
    } else {
      const attrs = Object.entries(rest).map(([key, value]) => ` ${key}=${JSON.stringify(value)}`).join('')
      if (type === 'script') {
        ret.head.push(`<${type}${attrs}>${Array.isArray(children) ? children.join('') : children || ''}</${type}>`)
      } else if (util.isNEString(children)) {
        ret.head.push(`<${type}${attrs} ssr>${children}</${type}>`)
      } else if (util.isNEArray(children)) {
        ret.head.push(`<${type}${attrs} ssr>${children.join('')}</${type}>`)
      } else {
        ret.head.push(`<${type}${attrs} ssr />`)
      }
    }
  })

  // get script tags
  scriptElements.forEach(({ props }) => {
    const { children, dangerouslySetInnerHTML, ...attrs } = props
    if (dangerouslySetInnerHTML && util.isNEString(dangerouslySetInnerHTML.__html)) {
      ret.scripts.push({ ...attrs, innerText: dangerouslySetInnerHTML.__html })
    } if (util.isNEString(children)) {
      ret.scripts.push({ ...attrs, innerText: children })
    } else if (util.isNEArray(children)) {
      ret.scripts.push({ ...attrs, innerText: children.join('') })
    } else {
      ret.scripts.push(props)
    }
  })

  // get styles
  await Promise.all(Array.from(styleLinks.values()).map(async ({ module }) => {
    await import('file://' + util.cleanPath(`${Deno.cwd()}/.aleph/${buildMode}/${module}`))
  }))
  serverStyles.forEach((css, url) => {
    ret.head.push(`<style type="text/css" data-module-id=${JSON.stringify(url)} ssr>${css}</style>`)
  })

  defer()
  return ret
}
