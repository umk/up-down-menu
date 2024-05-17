import readline from 'readline'

export interface MenuItem {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  select(context: MenuContext): Promise<MenuContext | void> | MenuContext | void
  render(): string
}

export type MenuContext = {
  rl: readline.Interface
  items: Array<MenuItem>
  message: string | undefined
}

type MemoizeFunction<P extends Array<unknown>, R> = ((...params: P) => R) & {
  current(): CurrentValue<R>
}

type CurrentValue<R> = R extends Promise<infer V> ? V : R

function memoize<P extends Array<unknown>, R>(fn: (...params: P) => R): MemoizeFunction<P, R> {
  let currentParams: P | undefined
  let currentValueOrPromise: R | undefined
  let currentValue: CurrentValue<R> | undefined
  const getter = (...params: P) => {
    if (!currentParams || !params.every((p, i) => (currentParams as P)[i] === p)) {
      currentValueOrPromise = fn(...params)
      if (currentValueOrPromise instanceof Promise) {
        currentValue = undefined
        currentValueOrPromise = currentValueOrPromise.then((result) => {
          currentValue = result
          return result
        }) as R
      } else {
        currentValue = currentValueOrPromise as CurrentValue<R>
      }
      currentParams = params
    }
    return currentValueOrPromise as R
  }
  return Object.assign(getter, {
    current() {
      if (!currentParams) throw new Error('The value is not initialized yet')
      return currentValue as CurrentValue<R>
    },
  })
}

export type CaptionFunction = (context: MenuContext) => string | Promise<string>

export type FilterFunction = (items: Array<MenuItem>, query: string) => Array<MenuItem>

export class UpDownMenu {
  private readonly pageSize: number
  private readonly prompt: string

  private context: MenuContext
  private contextId = 0

  private caption:
    | MemoizeFunction<[context: MenuContext, contextId: number], string | Promise<string>>
    | undefined

  private query = ''
  private queryItems:
    | MemoizeFunction<[items: Array<MenuItem>, query: string, contextId: number], Array<MenuItem>>
    | undefined

  private offset = 0
  private cursor = 0

  private hold = false

  constructor(
    rl: readline.Interface,
    items: Array<MenuItem>,
    options?: {
      caption?: CaptionFunction
      filter?: FilterFunction
      pageSize?: number
      prompt?: string
    },
  ) {
    const { caption, filter, pageSize = 10, prompt = '$' } = options || {}

    this.pageSize = pageSize
    this.prompt = prompt

    this.context = { rl, items, message: undefined }
    this.caption = caption && memoize(caption)
    this.queryItems = filter && memoize(filter)
  }

  async listen() {
    await this.caption?.(this.context, this.contextId)
    this.refreshNoThrow()

    process.stdin.on(
      'keypress',
      (chunk: string | undefined, key: { shift: boolean; sequence: string }) => {
        if (this.hold) return
        this.context.message = undefined
        switch (key.sequence) {
          case '\u001b[A':
            this.cursor--
            break
          case '\u001b[B':
            this.cursor++
            break
          case '\u001b[D':
            this.cursor = 0
            break
          case '\u001b[C':
            this.cursor = Number.POSITIVE_INFINITY
            break
          case '\u001b':
            // The refresh is handled in the 'data' event handler, which
            // also will refresh the the menu by itself.
            return
          case '\r':
            {
              const { [this.cursor]: current } = this.getQueryItems()
              if (current) {
                this.context.rl.write('\n')
                this.invokeSelectNoThrow(current).finally(() => {
                  this.query = ''
                  this.refreshNoThrow()
                })
                // Going to refresh upon completion of select function.
                return
              }
            }
            break
          case '\u007f':
            if (this.queryItems) {
              this.query = this.query.substring(0, this.query.length - 1)
            }
            break
          default:
            if (this.queryItems) {
              this.query += chunk || ''
            }
            break
        }
        this.refreshNoThrow()
      },
    )

    process.stdin.on('data', (data) => {
      if (this.hold) return
      if (data.length === 1 && data.at(0) === 0x1b) {
        this.query = ''
        this.refreshNoThrow()
      }
    })
  }

  private refreshNoThrow() {
    try {
      this.refresh()
    } catch {
      // Do nothing
    }
  }

  private refresh() {
    if (this.hold) return

    const query = this.query.trim()
    const queryItems = this.getQueryItems()

    this.cursor = Math.min(this.cursor, queryItems.length - 1)
    this.cursor = Math.max(this.cursor, 0)

    this.offset = Math.min(this.offset, this.cursor)
    this.offset = Math.max(this.offset, this.cursor - this.pageSize + 1)

    if (this.cursor - this.offset === this.pageSize - 1 && this.cursor < queryItems.length - 1) {
      this.offset++
    }

    if (this.cursor === this.offset && this.cursor > 0) {
      this.offset--
    }

    const scrollUp = this.offset > 0
    const scrollDown = this.offset + this.pageSize < queryItems.length

    const displayItems = queryItems.slice(
      this.offset + Number(scrollUp),
      this.offset + this.pageSize - Number(scrollDown),
    )

    this.context.rl.write('\u001bc') // Clear screen
    if (displayItems.length === 0) {
      if (query.length === 0) {
        this.context.rl.write('There are no items\n')
      } else {
        this.context.rl.write('There are no items matching the query\n')
      }
    }
    if (scrollUp) this.context.rl.write('   ...\n')
    displayItems.forEach((item) => {
      const isCursorOnItem = item === queryItems[this.cursor]
      const cursor = isCursorOnItem ? '>' : ' '
      this.context.rl.write(`${cursor} ${item.render()}\n`)
    })
    if (scrollDown) this.context.rl.write('   ...\n')
    this.context.rl.write('\n')
    const caption = this.caption?.current()
    if (caption) {
      this.context.rl.write(caption)
      this.context.rl.write('\n\n')
    }
    if (this.context.message) {
      this.context.rl.write(this.context.message)
      this.context.rl.write('\n\n')
    }
    if (this.queryItems) {
      this.context.rl.write(this.prompt + ' ' + this.query)
    }
  }

  private getQueryItems() {
    return this.queryItems?.(this.context.items, this.query, this.contextId) || this.context.items
  }

  private async invokeSelectNoThrow(current: MenuItem): Promise<void> {
    try {
      this.hold = true
      const contextOrVoid = await current.select(this.context)
      if (contextOrVoid) {
        this.context = contextOrVoid
      }
      this.contextId++
      await this.caption?.(this.context, this.contextId)
    } catch (error) {
      this.context.message = String(error)
    } finally {
      this.hold = false
    }
  }
}
