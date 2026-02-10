# Socket.IO Usage Documentation

This document introduces the Socket.IO bidirectional communication functionality of Peta Core.

## Overview

Socket.IO provides real-time bidirectional communication capabilities between server and clients, supporting:

- ✅ **Server-initiated Push**: Push notifications to specified users or all users
- ✅ **Client Messages**: Clients can send messages to server
- ✅ **Token Authentication**: Verify user identity during handshake
- ✅ **Multi-device Login**: Same user can connect on multiple devices simultaneously
- ✅ **Auto-reconnection**: Client automatically reconnects after disconnection
- ✅ **Independent from MCP**: Does not affect existing MCP SSE push mechanism

## Architecture Description

Socket.IO server is attached to the existing Express HTTP/HTTPS server (port 3002), completely independent from MCP routes:

```
┌─────────────────────────────────────────────────────────────┐
│                    Peta Core (3002)                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐         ┌──────────────────────────────┐   │
│  │   Express   │────────>│   HTTP/HTTPS Server          │   │
│  │   Router    │         └──────────────────────────────┘   │
│  └─────────────┘                      │                     │
│        │                              │                     │
│        │                              ▼                     │
│        │                    ┌──────────────────┐            │
│        │                    │   Socket.IO      │            │
│        │                    │   Server         │            │
│        │                    └──────────────────┘            │
│        │                               │                    │
│        ▼                               ▼                    │
│  ┌──────────┐              ┌──────────────────┐             │
│  │  /mcp    │              │  /socket.io      │             │
│  │  (SSE)   │              │  (WebSocket)     │             │
│  └──────────┘              └──────────────────┘             │
│        │                               │                    │
└────────┼───────────────────────────────┼────────────────────┘
         │                               │
         ▼                               ▼
   ┌──────────┐                 ┌──────────────┐
   │   MCP    │                 │   Electron   │
   │ Clients  │                 │   Clients    │
   │ (Claude) │                 │  (Desktop)   │
   └──────────┘                 └──────────────┘
```

---

## Server Usage

### 1. Push Notification to Specified User

Use `socketNotifier` utility class to push notifications:

```typescript
import { socketNotifier } from './socket/SocketNotifier.js';

// Push to all devices of specified user
socketNotifier.notifyUser('user123', 'notification', {
  type: 'system_message',
  message: 'Hello from server!',
  timestamp: Date.now(),
  severity: 'info'
});
```

### 2. Using Convenient Push Functions

```typescript
// Push user disabled notification
socketNotifier.notifyUserDisabled('user123', 'Violates terms of service');

// Push permission change notification
socketNotifier.notifyPermissionChanged('user123', 'Your permissions have been updated');

// Push system message (to specified user)
socketNotifier.sendSystemMessage('user123', 'System maintenance in 10 minutes', 'warning');

// Broadcast system message (to everyone)
socketNotifier.sendSystemMessage(null, 'System maintenance completed', 'success');

// Push user online session list
socketNotifier.notifyOnlineSessions('user123');
```

### 3. Push User Online Session List

The system automatically tracks user MCP session status and proactively pushes notifications when sessions are created, initialized, or closed.

#### Automatic Trigger Timing

The following situations automatically trigger online session list notifications:

1. **Socket.IO Connection Established**: When user successfully connects via Socket.IO, immediately push current all active MCP session list
2. **MCP Session Initialization Completed**: When MCP client completes `initialize` request, push updated session list
3. **MCP Session Closed**: When MCP session closes (normal close or timeout), push updated session list

#### Manual Trigger

```typescript
import { socketNotifier } from './socket/SocketNotifier.js';

// Push user's online session list
const success = socketNotifier.notifyOnlineSessions('user123');

if (success) {
  console.log('✅ Online session notification sent');
} else {
  console.log('❌ User offline or notification failed');
}
```

#### Notification Data Structure

Clients will receive notifications in the following format:

```typescript
{
  type: 'online_sessions',
  message: 'You have 3 active session(s)',  // Dynamically generated based on session count
  data: {
    sessions: [
      {
        sessionId: "sess_abc123",           // MCP session ID
        clientName: "Claude Desktop",       // Client application name
        userAgent: "Mozilla/5.0...",        // HTTP User-Agent
        lastActive: "2025-01-15T10:00:00Z"  // Last active time (ISO 8601)
      },
      {
        sessionId: "sess_xyz789",
        clientName: "Web Client",
        userAgent: "Mozilla/5.0...",
        lastActive: "2025-01-15T10:05:00Z"
      }
    ]
  },
  timestamp: 1736935200000,
  severity: 'info'
}
```

#### Field Description

- `sessionId`: Unique identifier for MCP session
- `clientName`: Client application name (obtained from MCP `initialize` request's `clientInfo.name`)
  - If client doesn't provide, displays as `"Unknown Client"`
- `userAgent`: HTTP User-Agent string (obtained from HTTP request header)
  - If not obtained, displays as `"Unknown"`
- `lastActive`: Session last active time (ISO 8601 format)

#### Client Handling Example

```typescript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3002', {
  auth: { token: 'your-token' }
});

// Listen for online session notifications
socket.on('notification', (data) => {
  if (data.type === 'online_sessions') {
    console.log(`You have ${data.data.sessions.length} active sessions:`);

    data.data.sessions.forEach(session => {
      console.log(`- ${session.clientName} (${session.sessionId})`);
      console.log(`  Last active: ${new Date(session.lastActive).toLocaleString()}`);
      console.log(`  User-Agent: ${session.userAgent}`);
    });

    // Update UI display
    updateSessionList(data.data.sessions);
  }
});
```

#### Use Cases

1. **Multi-device Management**: Display user's current all active connections in desktop app, allow user to close sessions from other devices
2. **Security Monitoring**: Detect abnormal logins, if user sees unknown sessions, can immediately disconnect
3. **Session Synchronization**: Synchronize session status between multiple clients, remind user that other devices are in use
4. **Debugging Tool**: Developers can view current active session details, convenient for troubleshooting

#### Technical Implementation Notes

**Data Sources:**
- `sessionId`: From `ClientSession.sessionId` (generated when creating MCP session)
- `clientName`: From MCP `initialize` request's `clientInfo.name` field
- `userAgent`: From HTTP request header `User-Agent` when creating MCP session
- `lastActive`: From `ClientSession.lastActive` (automatically updated on each request)

**Storage Location:**
- Session information stored in `SessionStore`'s in-memory map (`Map<sessionId, ClientSession>`)
- Each user's session collection managed through `userSessions` map (`Map<userId, Set<sessionId>>`)

**Notification Trigger Points:**
1. `src/socket/SocketService.ts:404` - After Socket.IO connection established
2. `src/mcp/core/ClientSession.ts:73` - After MCP Session initialization completed
3. `src/mcp/core/ClientSession.ts:664` - After MCP Session closed

### 4. Broadcast to All Online Users

```typescript
socketNotifier.notifyAll('notification', {
  type: 'system_update',
  message: 'New features available!',
  timestamp: Date.now(),
  severity: 'info'
});
```

### 5. Query Online Status

```typescript
// Check if user is online
const isOnline = socketNotifier.isUserOnline('user123');

// Get user's online device count
const deviceCount = socketNotifier.getUserDeviceCount('user123');

// Get user's connection information
const connections = socketNotifier.getUserConnections('user123');

// Get all online user IDs
const onlineUsers = socketNotifier.getOnlineUserIds();

// Get total connection count
const totalConnections = socketNotifier.getTotalConnections();
```

### 6. Using in Admin Operations

Example: Push notification when disabling user

```typescript
import { socketNotifier } from '../socket/SocketNotifier.js';

// In UserHandler or other admin controllers
async disableUser(userId: string, reason?: string) {
  // 1. Update database
  await userRepository.updateStatus(userId, UserStatus.Disabled);

  // 2. Push notification to all devices of that user
  socketNotifier.notifyUserDisabled(userId, reason);

  // 3. Optional: Disconnect all MCP sessions of that user
  await sessionStore.removeUserSessions(userId);
}
```

---

## Request-Response Pattern

### Overview

In addition to one-way notifications, Socket.IO also supports **request-response pattern**, allowing server to send requests and wait for client responses.

**Core Features:**
- ✅ Standardized message structure similar to AdminRequest/Response
- ✅ Automatically generate unique requestId to associate requests and responses
- ✅ Configurable response timeout (default 55 seconds)
- ✅ Complete TypeScript generic support
- ✅ Never throws exceptions, always returns SocketResponse object
- ✅ Automatically clean up timed-out and disconnected requests

### SocketActionType Operation Types

Currently supported operation types (can be extended at any time):

```typescript
export enum SocketActionType {
  // ========== 1000-1999: User Confirmation ==========
  ASK_USER_CONFIRM = 1001,              // Request user confirmation for operation
  ASK_USER_SELECT = 1002,               // Request user selection

  // ========== 2000-2999: Client Status Query ==========
  GET_CLIENT_STATUS = 2001,             // Get client status
  GET_CURRENT_PAGE = 2002,              // Get current page information
  GET_CLIENT_CONFIG = 2003,             // Get client configuration
  GET_CONNECTION_INFO = 2004,           // Get connection information

  // ========== 3000-3999: Capability Configuration ==========
  GET_CAPABILITIES = 3001,              // Get user capability configuration
}
```

### Core Method: sendRequest()

Send request and wait for client response (async method).

**Method Signature:**

```typescript
async sendRequest<TReq = any, TRes = any>(
  userId: string,
  action: SocketActionType,
  data: TReq,
  timeout: number = 55000
): Promise<SocketResponse<TRes>>
```

**Parameter Description:**
- `userId` - User ID
- `action` - Operation type (SocketActionType enum)
- `data` - Request data (generic TReq)
- `timeout` - Timeout time (milliseconds), default 55000ms (55 seconds)

**Return Value:**
- `Promise<SocketResponse<TRes>>` - Always returns response object, never throws exception

**Usage Example:**

```typescript
import { socketNotifier } from './socket/SocketNotifier.js';
import { SocketActionType } from './socket/types/socket.types.js';

// Example 1: Use default timeout (55 seconds)
const response = await socketNotifier.sendRequest<
  { message: string },          // Request data type
  { confirmed: boolean }        // Response data type
>('user123', SocketActionType.ASK_USER_CONFIRM, {
  message: 'Are you sure you want to delete this server?'
});

if (response.success) {
  console.log('User confirmed:', response.data.confirmed);
  if (response.data.confirmed) {
    await deleteServer(serverId);
  }
} else {
  console.error('Request failed:', response.error?.message);
  // Possible errors: USER_OFFLINE, TIMEOUT, CLIENT_ERROR, etc.
}

// Example 2: Custom timeout
const response = await socketNotifier.sendRequest(
  'user123',
  SocketActionType.GET_CLIENT_STATUS,
  {},
  10000  // 10 second timeout
);
```

### Convenient Wrapper Methods

#### askUserConfirm() - Request User Confirmation

```typescript
async askUserConfirm(
  userId: string,
  toolName: string,
  toolDescription: string,
  toolParams: string,
  timeout?: number
): Promise<boolean>
```

**Parameter Description:**
- `userId` - User ID
- `toolName` - Tool name
- `toolDescription` - Tool description
- `toolParams` - Tool parameters (JSON string format)
- `timeout` - Timeout time (milliseconds), default 55000ms

**Return Value:**
- `true` - User explicitly confirmed
- `false` - User rejected or timed out

**Example:**

```typescript
const confirmed = await socketNotifier.askUserConfirm(
  'user123',
  'delete_server',
  'Delete a server permanently',
  JSON.stringify({ serverId: 'abc123', force: true })
);

if (confirmed) {
  // User confirmed, execute operation
  await deleteServer('abc123');
} else {
  // User rejected or timed out
  console.log('Operation cancelled by user or timed out');
}
```

#### getClientStatus() - Get Client Status

```typescript
async getClientStatus(
  userId: string,
  timeout: number = 5000
): Promise<any | null>
```

**Example:**

```typescript
const status = await socketNotifier.getClientStatus('user123');

if (status) {
  console.log('Client status:', status);
} else {
  console.log('Failed to get client status');
}
```

---

## Capability Configuration Management

### Overview

User capability configuration management allows clients to get and set their own MCP server capability configurations (`user_preferences`) through Socket.IO, enabling client-side custom permission control.

**Core Features:**
- ✅ Get current complete capability configuration (includes merged result of admin permissions + user custom configuration)
- ✅ Set user custom configuration (can only further restrict, cannot expand permissions)
- ✅ Real-time notification to all active sessions of configuration changes
- ✅ Automatic validation of configuration legality

### Permission Merge Rules

```
Final Permission = Admin Configured Permissions && User Custom Configuration

final_enabled = admin_permissions.enabled && user_preferences.enabled
```

**Description:**
- Admin configured `permissions` is the baseline (upper limit) of permissions
- Users can only further restrict through `user_preferences`, cannot expand permissions
- Items not configured by user default to follow admin configuration

### 1. Get Capability Configuration

Get current user's complete capability configuration through Socket.IO request-response pattern.

#### Server Sends Request

```typescript
import { socketNotifier } from './socket/SocketNotifier.js';

// Get user's capability configuration (default 5 second timeout)
const capabilities = await socketNotifier.getCapabilities('user123');

if (capabilities) {
  console.log('User capability configuration:', JSON.stringify(capabilities, null, 2));
} else {
  console.log('Failed to get (user offline or timeout)');
}
```

#### Client Handles Request (Electron)

```typescript
import { SocketRequest, SocketResponse, SocketActionType } from './socket.types';

// Listen for get_capabilities request
socket.on('get_capabilities', async (request: SocketRequest<{}>) => {
  console.log('Received get capability configuration request');

  // Get from local or query server
  // Note: Usually client will directly return empty object, let server handle it
  // This event is mainly used to trigger client UI update

  const response: SocketResponse<{ capabilities: any }> = {
    requestId: request.requestId,
    success: true,
    data: { capabilities: {} }, // Empty object means server decides
    timestamp: Date.now()
  };

  socket.emit('socket_response', response);
});
```

#### Returned Data Format

```typescript
// McpServerCapabilities structure
{
  "server-id-1": {
    "enabled": true,
    "tools": {
      "tool-name-1": {
        "enabled": true,
        "description": "Tool description",
        "dangerLevel": 0
      },
      "tool-name-2": {
        "enabled": false,  // User disabled
        "description": "Another tool",
        "dangerLevel": 1
      }
    },
    "resources": {
      "resource-name-1": {
        "enabled": true,
        "description": "Resource description"
      }
    },
    "prompts": {
      "prompt-name-1": {
        "enabled": true,
        "description": "Prompt description"
      }
    }
  },
  "server-id-2": {
    "enabled": false,  // Entire server disabled
    "tools": {},
    "resources": {},
    "prompts": {}
  }
}
```

### 2. Set Capability Configuration

Set user custom configuration directly through Socket.IO events.

#### Client Sends Setting Request

```typescript
// Client sends set_capabilities event
socket.emit('set_capabilities', {
  requestId: 'req-' + Date.now(),  // Optional, for tracking
  data: {
    // Only need to set parts to modify
    "server-id-1": {
      "enabled": true,
      "tools": {
        "dangerous-tool": {
          "enabled": false,  // Disable dangerous tool
          "description": "...",
          "dangerLevel": 2
        }
      },
      "resources": {},
      "prompts": {}
    }
  }
});

// Listen for response
socket.on('ack', (data) => {
  console.log('Configuration updated:', data);
});
```

#### Server Processing (SocketService.ts)

Server automatically handles `set_capabilities` event:

1. Verify user identity
2. Get current complete configuration
3. Extract and validate user submitted `enabled` fields
4. Update database (`user_preferences` field)
5. Notify all active sessions of that user

#### Validation Rules

- ✅ Only accept existing server/tool/resource/prompt
- ✅ Only save `enabled`, `description`, `dangerLevel` fields
- ✅ Ignore non-existent items or invalid fields
- ✅ Do not allow expanding permissions (can only disable, cannot enable items disabled by admin)

### 3. Automatic Notification Mechanism

When user configuration is updated, the system automatically:

1. **Update Database**: Save to `users.user_preferences` field
2. **Notify All Sessions**: Send notifications to all active MCP sessions of that user
3. **Incremental Notification**: Only notify changed parts (tools/resources/prompts)

#### Notification Events

Clients will receive the following MCP protocol notifications (via SSE):

```json
// When tools change
{
  "jsonrpc": "2.0",
  "method": "notifications/tools/list_changed"
}

// When resources change
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/list_changed"
}

// When prompts change
{
  "jsonrpc": "2.0",
  "method": "notifications/prompts/list_changed"
}
```

At the same time, if client is connected via Socket.IO, will also receive:

```json
// Socket.IO notification event
{
  "type": "permission_changed",
  "message": "User permissions have been updated",
  "data": {
    "capabilities": { /* latest configuration */ }
  },
  "timestamp": 1234567890,
  "severity": "warning"
}
```

### 4. Complete Example: Client Implementation

```typescript
import { io } from 'socket.io-client';

// Connect to server
const socket = io('http://localhost:3002', {
  auth: { token: 'your-token' }
});

// ========== Get Current Configuration ==========
async function getCurrentCapabilities() {
  return new Promise((resolve) => {
    const requestId = 'req-' + Date.now();

    // Send request
    socket.emit('get_capabilities', {
      requestId,
      data: {}
    });

    // Wait for response (one-time listener)
    socket.once('socket_response', (response) => {
      if (response.requestId === requestId && response.success) {
        resolve(response.data?.capabilities);
      } else {
        resolve(null);
      }
    });
  });
}

// ========== Set Configuration ==========
function setCapabilities(newConfig) {
  socket.emit('set_capabilities', {
    requestId: 'req-' + Date.now(),
    data: newConfig
  });
}

// ========== Usage Example ==========

// Get configuration
const currentConfig = await getCurrentCapabilities();
console.log('Current configuration:', currentConfig);

// Disable a tool
setCapabilities({
  "filesystem": {
    "enabled": true,
    "tools": {
      "delete_file": {
        "enabled": false,  // Disable delete file tool
        "description": "Delete a file",
        "dangerLevel": 2
      }
    },
    "resources": {},
    "prompts": {}
  }
});

// Listen for confirmation
socket.on('ack', (data) => {
  console.log('✅ Configuration updated');

  // Re-fetch latest configuration
  getCurrentCapabilities().then(config => {
    console.log('Latest configuration:', config);
  });
});
```

### 5. Database Field

User custom configuration is stored in `users` table's `user_preferences` field:

```sql
-- user_preferences field stores JSON string
-- Example:
{
  "server-id-1": {
    "enabled": true,
    "tools": {
      "tool-1": { "enabled": false, "description": "...", "dangerLevel": 1 }
    },
    "resources": {},
    "prompts": {}
  }
}
```

### 6. API Summary

| Operation | Method | Event Name | Data Format |
|-----|------|--------|---------|
| Get Configuration | Request-Response | `get_capabilities` | `SocketRequest<{}>` |
| Set Configuration | Client Event | `set_capabilities` | `{ requestId, data: McpServerCapabilities }` |
| Configuration Update Notification | Server Push | `notification` | `{ type: 'permission_changed', data: { capabilities } }` |

### Error Handling

All request-response methods **never throw exceptions**, always return `SocketResponse` object.

**SocketErrorCode Error Codes:**

```typescript
export enum SocketErrorCode {
  // General errors (1000-1099)
  TIMEOUT = 1001,                       // Response timeout
  USER_OFFLINE = 1002,                  // User offline
  INVALID_REQUEST = 1003,               // Invalid request
  UNKNOWN_ACTION = 1004,                // Unknown operation type

  // Client errors (1100-1199)
  CLIENT_ERROR = 1101,                  // Client processing error
  USER_REJECTED = 1102,                 // User rejected operation
  USER_CANCELLED = 1103,                // User cancelled operation
  PERMISSION_DENIED = 1104,             // Insufficient permissions

  // Server errors (1200-1299)
  SERVER_ERROR = 1201,                  // Server internal error
  SERVICE_UNAVAILABLE = 1202,           // Service unavailable
}
```

**Error Handling Example:**

```typescript
const response = await socketNotifier.sendRequest(...);

if (!response.success) {
  switch (response.error?.code) {
    case SocketErrorCode.USER_OFFLINE:
      console.log('User is offline');
      break;
    case SocketErrorCode.TIMEOUT:
      console.log('Request timed out');
      break;
    case SocketErrorCode.USER_REJECTED:
      console.log('User rejected the operation');
      break;
    default:
      console.log('Request failed:', response.error?.message);
  }
}
```

### Client Implementation Request Handling

Clients need to listen for corresponding events and send responses.

**Event Name Automatic Mapping Rules:**
- `SocketActionType.ASK_USER_CONFIRM` → Event name `'ask_user_confirm'`
- `SocketActionType.GET_CLIENT_STATUS` → Event name `'get_client_status'`

**Complete Client Implementation Example (Electron):**

```typescript
import { io, Socket } from 'socket.io-client';
import { dialog } from 'electron';
import {
  SocketRequest,
  SocketResponse,
  SocketActionType,
  SocketErrorCode
} from './socket.types';

// Connect to server
const socket = io('http://localhost:3002', {
  auth: { token: 'your-token-here' }
});

// Listen for 'ask_user_confirm' event
socket.on('ask_user_confirm', async (request: SocketRequest<{
  toolName: string;
  toolDescription: string;
  toolParams: string;
}>) => {
  try {
    // Parse tool parameters
    const params = JSON.parse(request.data.toolParams);

    // Construct confirmation message
    const message = `Tool: ${request.data.toolName}\nDescription: ${request.data.toolDescription}\nParameters: ${JSON.stringify(params, null, 2)}\n\nAre you sure you want to execute this operation?`;

    // Show confirmation dialog
    const result = await dialog.showMessageBox({
      type: 'question',
      message: message,
      buttons: ['Confirm', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });

    // Send response
    const response: SocketResponse = {
      requestId: request.requestId,
      success: true,
      data: { confirmed: result.response === 0 },
      timestamp: Date.now()
    };

    socket.emit('socket_response', response);
    console.log(`✅ Responded to request: ${request.requestId}`);

  } catch (error) {
    // Send error response
    const response: SocketResponse = {
      requestId: request.requestId,
      success: false,
      error: {
        code: SocketErrorCode.CLIENT_ERROR,
        message: error.message || 'Client error occurred'
      },
      timestamp: Date.now()
    };

    socket.emit('socket_response', response);
    console.error(`❌ Failed to handle request: ${request.requestId}`);
  }
});

// Listen for 'get_client_status' event
socket.on('get_client_status', (request: SocketRequest) => {
  const status = {
    platform: process.platform,
    appVersion: app.getVersion(),
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  };

  const response: SocketResponse = {
    requestId: request.requestId,
    success: true,
    data: status,
    timestamp: Date.now()
  };

  socket.emit('socket_response', response);
});
```

### Practical Application Scenarios

#### Scenario 1: Confirm Before Dangerous Tool Call

```typescript
// Confirm dangerous tool call in ProxySession
async handleToolCall(request: CallToolRequest) {
  // Check tool danger level
  if (dangerLevel === DangerLevel.Approval) {
    const toolDescription = getToolDescription(toolName);
    const toolParams = JSON.stringify(request.params.arguments);

    // Request user confirmation
    const confirmed = await socketNotifier.askUserConfirm(
      userId,
      toolName,
      toolDescription,
      toolParams
    );

    if (!confirmed) {
      throw new McpError(ErrorCode.InvalidRequest, 'User denied tool execution');
    }
  }

  // Execute tool call after user confirmation
  return await callTool(toolName, request.params.arguments);
}
```

#### Scenario 2: Get Client Status for Troubleshooting

```typescript
async diagnoseClientIssue(userId: string) {
  // Get client status
  const status = await socketNotifier.getClientStatus(userId, 10000);

  if (!status) {
    return { error: 'Unable to get client status' };
  }

  // Analyze status data
  const issues = [];
  if (status.memoryUsage.heapUsed > 1000000000) {
    issues.push('High memory usage');
  }
  if (status.uptime > 86400) {
    issues.push('Client needs restart');
  }

  return { status, issues };
}
```

### Timeout and Performance Considerations

**Default Timeout**: 55 seconds (55000ms)

**Recommended Timeout Configuration:**
- Quick operations (get status): 5-10 seconds
- User confirmation operations: 30-60 seconds
- Complex operations: 60-120 seconds

**Performance Monitoring:**

```typescript
// Get pending request count
const pendingCount = socketService.getPendingRequestCount();
console.log(`Current pending requests: ${pendingCount}`);
```

---

## Client Usage

### Install Dependencies

```bash
npm install socket.io-client
```

### Basic Connection Example

```typescript
import { io } from 'socket.io-client';

// Create connection
const socket = io('http://localhost:3002', {
  auth: {
    token: 'your-user-token-here'  // Recommended method
  },
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000
});

// Listen for successful connection
socket.on('connect', () => {
  console.log('Connected! Socket ID:', socket.id);

  // Send client information (optional)
  socket.emit('client-info', {
    deviceType: 'desktop',
    deviceName: 'MacBook Pro',
    appVersion: '1.0.0'
  });
});

// Listen for server push notifications
socket.on('notification', (data) => {
  console.log('Notification:', data);
  // Show desktop notification or update UI
});

// Send message to server
socket.emit('client-message', {
  action: 'test',
  data: { foo: 'bar' }
});

// Listen for message acknowledgment
socket.on('ack', (data) => {
  console.log('Message acknowledged:', data);
});

// Disconnect
socket.disconnect();
```

### Electron Complete Example

See `examples/electron-client/SocketClient.ts` and `examples/electron-client/README.md`

---

## Event List

### Client → Server

| Event Name | Description | Data Format |
|---------|------|---------|
| `client-info` | Send device information (optional) | `{ deviceType?, deviceName?, appVersion? }` |
| `client-message` | Client message | Any data |
| `set_capabilities` | Set user capability configuration | `{ requestId?, data: McpServerCapabilities }` |
| `socket_response` | Respond to server request | `SocketResponse<T>` |

### Server → Client

| Event Name | Description | Data Format |
|---------|------|---------|
| `notification` | Server push notification | `{ type, message, timestamp, severity?, data? }` |
| `ack` | Message acknowledgment | `{ message, timestamp }` |
| `error` | Error message | `{ message }` |
| `ask_user_confirm` | Request user confirmation | `SocketRequest<{ toolName, toolDescription, toolParams }>` |
| `get_client_status` | Get client status | `SocketRequest<{}>` |
| `get_capabilities` | Get capability configuration | `SocketRequest<{}>` |

### Socket.IO Built-in Events

| Event Name | Description |
|---------|------|
| `connect` | Connection successful |
| `disconnect` | Connection disconnected |
| `reconnect` | Reconnection successful |
| `connect_error` | Connection error (e.g., authentication failed) |

---

## Notification Types

Predefined notification type constants (in `src/socket/types/socket.types.ts`):

### User Management
- `user_disabled` - User disabled
- `user_enabled` - User enabled
- `user_expired` - User expired
- `user_deleted` - User deleted

### Permission Management
- `permission_changed` - Permissions changed
- `permission_revoked` - Permissions revoked

### System Messages
- `system_message` - System message
- `system_maintenance` - System maintenance
- `system_update` - System update

### Business Messages
- `business_message` - Business message
- `task_notification` - Task notification

### Session Management
- `online_sessions` - Online session list changed

### Server Status
- `server_status_change` - Server status changed
- `mcp_server_online` - MCP server online
- `mcp_server_offline` - MCP server offline

---

## Data Formats

### NotificationData

```typescript
interface NotificationData {
  type: string;             // Notification type
  message: string;          // Notification message content
  timestamp: number;        // Timestamp (milliseconds)
  data?: any;               // Additional data (optional)
  severity?: 'info' | 'warning' | 'error' | 'success';  // Severity (optional)
}
```

### UserConnection

```typescript
interface UserConnection {
  userId: string;           // User ID
  socketId: string;         // Socket.IO connection ID
  deviceType?: string;      // Device type
  deviceName?: string;      // Device name
  appVersion?: string;      // Client application version
  connectedAt: Date;        // Connection time
}
```

### OnlineSessionData

```typescript
interface OnlineSessionData {
  sessionId: string;        // MCP session ID
  clientName: string;       // Client application name
  userAgent: string;        // HTTP User-Agent
  lastActive: Date;         // Last active time
}
```

---

## Authentication Mechanism

### Server Authentication Flow

1. Client carries Token in `auth.token` or `Authorization` header when connecting
2. Server calls `TokenValidator.validateToken(token)` during handshake
3. If validation fails, throws `AuthError` exception and disconnects
4. If validation succeeds, gets `AuthContext`, stores `userId` in `socket.data`
5. Join socket to Room named with `userId`

### Client Authentication Methods

**Recommended Method** (using `auth` object):

```typescript
const socket = io('http://localhost:3002', {
  auth: {
    token: 'your-access-token-here'
  }
});
```

**Alternative Method** (using `extraHeaders`):

```typescript
const socket = io('http://localhost:3002', {
  extraHeaders: {
    Authorization: 'Bearer your-access-token-here'
  }
});
```

---

## Health Check

Access `/health` endpoint to view Socket.IO status:

```bash
curl http://localhost:3002/health
```

Response example:

```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:00:00.000Z",
  "uptime": 3600,
  "sessions": {
    "active": 5,
    "total": 10
  },
  "socketio": {
    "onlineUsers": 3,
    "totalConnections": 5
  },
  "servers": { ... },
  "memory": { ... }
}
```

---

## Testing

### Using Postman or curl to Test Server Push

Since Socket.IO requires WebSocket connection, recommend using the following tools for testing:

1. **Socket.IO Client Testing Tool**: https://socket.io/docs/v4/testing/
2. **Chrome Extension**: Socket.IO Tester
3. **Node.js Script**: See `examples/` directory

### Quick Test Script

Create `test-socket.js`:

```javascript
const io = require('socket.io-client');

const socket = io('http://localhost:3002', {
  auth: {
    token: 'your-test-token-here'
  }
});

socket.on('connect', () => {
  console.log('✅ Connected:', socket.id);
});

socket.on('notification', (data) => {
  console.log('📬 Notification:', data);
});

socket.on('connect_error', (error) => {
  console.error('❌ Error:', error.message);
});

// Send test message
setTimeout(() => {
  socket.emit('client-message', { test: true });
}, 1000);
```

Run:

```bash
node test-socket.js
```

---

## Troubleshooting

### Connection Failure

1. **Check if server is running**: Access `http://localhost:3002/health`
2. **Check if Token is valid**: Ensure Token is not expired and user is not disabled
3. **View server logs**: Server will output detailed authentication failure reasons
4. **Check firewall**: Ensure port 3002 is accessible

### Authentication Failure

Server logs will show specific errors:

```
❌ Socket authentication failed: User not found (type: USER_NOT_FOUND)
❌ Socket authentication failed: User is Disabled (type: USER_DISABLED)
❌ Socket authentication failed: User authorization has expired (type: USER_EXPIRED)
```

### Notification Not Received

1. **Check if user is online**: Use `socketNotifier.isUserOnline(userId)`
2. **Check if userId is correct**: Ensure using `authContext.userId`
3. **View server logs**: Confirm if notification was sent successfully

---

## Performance Considerations

- **Connection Limit**: Default unlimited, production environment recommend configuring `maxHttpBufferSize` and `pingTimeout`
- **Memory Management**: `SocketService` uses Map to store connection mappings, automatically cleans up disconnected connections
- **Log Output**: Production environment can adjust log level to reduce output

---

## Security Recommendations

1. **Token Protection**: Clients should not hardcode Token in code
2. **CORS Configuration**: Production environment should configure specific `origin`, do not use `*`
3. **Rate Limiting**: Recommend adding rate limiting for Socket.IO events
4. **Message Validation**: Server should validate message format sent by clients

---

## Extended Features (Future)

The following features can be implemented in future versions:

- [ ] Offline message queue
- [ ] Redis Adapter (multi-server cluster)
- [ ] Limit maximum connections per user
- [ ] Token refresh mechanism
- [ ] Message persistence
- [ ] Heartbeat detection optimization
- [ ] Custom event permission control

---

## References

- **Socket.IO Official Documentation**: https://socket.io/docs/v4/
- **Socket.IO Client API**: https://socket.io/docs/v4/client-api/
- **Electron Integration**: https://www.electronjs.org/docs/latest/tutorial/notifications
