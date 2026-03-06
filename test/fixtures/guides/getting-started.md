# Getting Started

## Installation

```bash
npm install @framework/core
```

## Quick Start

### Step 1: Import the framework

```typescript
import { createApp } from '@framework/core';
```

### Step 2: Create your app

```typescript
const app = createApp({
  debug: true,
});
```

### Step 3: Mount to DOM

```typescript
app.mount('#app');
```

## Configuration

### Debug Mode

Enable debug mode for development:

```typescript
createApp({ debug: true });
```

### Production Mode

Disable debug for production:

```typescript
createApp({ debug: false });
```

## Next Steps

- Read the [API Reference](../api/endpoints.md)
- Explore [Components](../components/button.md)
