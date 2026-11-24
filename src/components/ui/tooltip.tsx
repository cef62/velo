'use client'
import { Portal } from '@ark-ui/react/portal'
import { Tooltip as ArkTooltip } from '@ark-ui/react/tooltip'
import { type ComponentProps, forwardRef } from 'react'
import { createStyleContext } from 'styled-system/jsx'
import { tooltip } from 'styled-system/recipes'

const { withRootProvider, withContext } = createStyleContext(tooltip)

type RootProps = ComponentProps<typeof Root>
type ContentProps = ComponentProps<typeof Content>
const Root = withRootProvider(ArkTooltip.Root, {
  defaultProps: { unmountOnExit: true, lazyMount: true },
})
const Arrow = withContext(ArkTooltip.Arrow, 'arrow')
const ArrowTip = withContext(ArkTooltip.ArrowTip, 'arrowTip')
const Content = withContext(ArkTooltip.Content, 'content')
const Positioner = withContext(ArkTooltip.Positioner, 'positioner')
const Trigger = withContext(ArkTooltip.Trigger, 'trigger')

export { TooltipContext as Context } from '@ark-ui/react/tooltip'

export interface TooltipProps extends Omit<RootProps, 'content'> {
  showArrow?: boolean
  portalled?: boolean
  portalRef?: React.RefObject<HTMLElement | null>
  children: React.ReactNode | undefined
  content: React.ReactNode | string
  contentProps?: ContentProps
  disabled?: boolean
}

// Whether the last key moved focus (Tab, Shift+Tab, an arrow key, Home/End/PageUp/PageDown in a roving group): only then does a keyboard focus ask for the tooltip.
let navKey = false
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => (navKey = e.key === 'Tab' || e.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(e.key)), true)
}

export const Tooltip = forwardRef<HTMLDivElement, TooltipProps>(function Tooltip(props, ref) {
  const {
    showArrow,
    children,
    disabled,
    portalled = true,
    content,
    contentProps,
    portalRef,
    ...rootProps
  } = props

  // Root's own `disabled` (not an early return): the same tree in both states keeps the trigger mounted, so focus survives a toggle
  return (
    <Root disabled={disabled} {...rootProps}>
      <ArkTooltip.Context>
        {(api) => (
          // zag opens a tooltip on any keyboard-modality focus, also focus a closing dialog hands back after Escape or Enter: shown
          // unasked, it would take the next Escape (#111). Only focus moved by a navigation key (navKey) keeps it; hover is unchanged.
          // A microtask: zag runs its own "open" in one, and a close sent in the same tick finds the tooltip not open yet.
          <Trigger asChild onFocus={() => !navKey && queueMicrotask(() => api.setOpen(false))}>
            {children}
          </Trigger>
        )}
      </ArkTooltip.Context>
      <Portal disabled={!portalled} container={portalRef}>
        <Positioner>
          <Content ref={ref} {...contentProps}>
            {showArrow && (
              <Arrow>
                <ArrowTip />
              </Arrow>
            )}
            {content}
          </Content>
        </Positioner>
      </Portal>
    </Root>
  )
})
