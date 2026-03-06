# Input Component

A form input component with validation support.

## Usage

```tsx
import { Input } from './input';

<Input
  type="email"
  placeholder="Enter email"
  onChange={handleChange}
/>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| type | 'text' \| 'email' \| 'password' | 'text' | Input type |
| placeholder | string | - | Placeholder text |
| error | string | - | Error message to display |

## Validation

The input supports built-in validation for:
- Required fields
- Email format
- Minimum/maximum length
