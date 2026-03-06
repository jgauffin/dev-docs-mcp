# API Endpoints

## Authentication

### POST /auth/login

Authenticates a user and returns a session token.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

### POST /auth/logout

Invalidates the current session.

## Users

### GET /users

Returns a list of all users.

### GET /users/:id

Returns a specific user by ID.

### POST /users

Creates a new user.

## Error Handling

All endpoints return errors in this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```
