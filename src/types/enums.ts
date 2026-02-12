export enum UserStatus {
  Disabled = 0, // Disabled/Unavailable
  Enabled = 1,  // Enabled/Available
  Pending = 2,  // Pending review (reserved)
  Suspended = 3 // Suspended (reserved)
}

export enum UserRole {
  Owner = 1, // Owner
  Admin = 2, // Administrator
  User = 3,  // Regular user
  Guest = 4  // Guest (reserved)
}

export enum ServerType {
  Local = 1,  // Local Server
  Remote = 2 // Remote Server
}

export enum ServerCategory {
  Template = 1,       // template server
  CustomRemote = 2,   // custom remote server
  RestApi = 3,        // RESTful API server
  Skills = 4,         // skills server
}

export enum ServerAuthType {
  ApiKey = 1,      // API Key authentication
  GoogleAuth = 2,   // Google OAuth authentication
  NotionAuth = 3,   // Notion OAuth authentication
  FigmaAuth = 4,   // Figma OAuth authentication
  GoogleCalendarAuth = 5,   // Google Calendar OAuth authentication
  GithubAuth = 6,   // Github OAuth authentication
  ZendeskAuth = 7,   // Zendesk OAuth authentication
  CanvasAuth = 8,   // Canvas OAuth authentication
}

export enum MCPEventLogType {
  // ========== 1000-1099: Client → Gateway (Upstream) ==========
  RequestTool = 1001,           // Gateway receives tools/call from Client
  RequestResource = 1002,       // Gateway receives resources/read from Client
  RequestPrompt = 1003,         // Gateway receives prompts/get from Client
  ResponseTool = 1004,          // Gateway returns tools/call result to Client
  ResponseResource = 1005,      // Gateway returns resources/read result to Client
  ResponsePrompt = 1006,        // Gateway returns prompts/get result to Client
  ResponseToolList = 1007,      // Gateway returns tools/list result to Client
  ResponseResourceList = 1008,  // Gateway returns resources/list result to Client
  ResponsePromptList = 1009,    // Gateway returns prompts/list result to Client


  // ========== 1200-1299: Reverse Requests (Server → Client) ==========
  ReverseSamplingRequest = 1201,   // Gateway receives sampling/createMessage from Server
  ReverseSamplingResponse = 1202,  // Gateway forwards sampling request to Client and returns
  ReverseRootsRequest = 1203,      // Gateway receives roots/list from Server
  ReverseRootsResponse = 1204,     // Gateway forwards roots request to Client and returns
  ReverseElicitRequest = 1205,     // Gateway receives prompts/list from Server (elicitation)
  ReverseElicitResponse = 1206,    // Gateway forwards elicit request to Client and returns

  // ========== 1300-1399: Session & Server Lifecycle ==========
  SessionInit = 1301,           // Client session initialized
  SessionClose = 1302,          // Client session closed (with reason)
  ServerInit = 1310,            // Downstream server initialized
  ServerClose = 1311,           // Downstream server closed
  ServerStatusChange = 1312,    // Server status changed (online/offline/connecting/error)
  ServerCapabilityUpdate = 1313, // Server capabilities updated
  ServerNotification = 1314,    // Server notification (ToolListChanged, ResourceListChanged, etc.)

  // ========== 2000-2099: OAuth ==========
  OAuthRegister = 2001,         // Client registration (DCR)
  OAuthAuthorize = 2002,        // Authorization code request
  OAuthToken = 2003,            // Token exchange
  OAuthRefresh = 2004,          // Token refresh
  OAuthRevoke = 2005,           // Token revocation
  OAuthError = 2010,            // OAuth-specific errors

  // ========== 3000-3099: Authentication & Authorization ==========
  AuthTokenValidation = 3001,   // Token validation
  AuthPermissionCheck = 3002,   // Permission check
  AuthRateLimit = 3003,         // Rate limit check
  AuthError = 3010,             // Authentication errors

  // ========== 4000-4099: Errors ==========
  ErrorInternal = 4001,         // Internal server errors

  // ========== 5000-5099: Admin Operations ==========
  AdminUserCreate = 5001,       // User created (1010)
  AdminUserEdit = 5002,         // User edited (1002, 1012)
  AdminUserDelete = 5003,       // User deleted (1013, 1014)
  AdminServerCreate = 5004,     // Server created (2010)
  AdminServerEdit = 5005,       // Server edited (2003, 2004, 2012)
  AdminServerDelete = 5006,     // Server deleted (2013)
  AdminProxyReset = 5007,       // Proxy reset/deleted (5004)
  AdminBackupDatabase = 5008,   // Database backup (6001)
  AdminRestoreDatabase = 5009,  // Database restore (6002)
  AdminDNSCreate = 5010,        // DNS record created/updated (8001)
  AdminDNSDelete = 5011,        // DNS record deleted (planned, no endpoint yet)
}

export enum ClientSessionStatus {
  Active = 0,   // Active
  Closed = 1,   // Closed
  Expired = 2,  // Expired
}

export enum ServerStatus {
  Online = 0,   // Online
  Offline = 1,  // Offline
  Connecting = 2, // Connecting
  Error = 3,    // Error
  Sleeping = 4  // Sleeping (lazy start)
}

export enum DangerLevel {
  Silent = 0,        // Execute Silently - Function executes automatically without user notification
  Notification = 1,  // Execute with Notification - Function executes automatically and displays result to user
  Approval = 2       // Require Manual Approval - User must manually approve before function execution
}