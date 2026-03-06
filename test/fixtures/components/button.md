# Button Component

A reusable button component.

## Usage

```tsx
import { Button } from './button';

<Button variant="primary" onClick={handleClick}>
  Click me
</Button>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| variant | 'primary' \| 'secondary' | 'primary' | Button style variant |
| disabled | boolean | false | Disables the button |
| onClick | () => void | - | Click handler |

## Variants

### Primary

Use for main actions.

### Secondary

Use for secondary actions.

## Accessibility

- Includes proper ARIA labels
- Supports keyboard navigation
