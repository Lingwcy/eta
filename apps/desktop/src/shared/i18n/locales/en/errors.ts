export default {
  InvalidInput: "Invalid request. Check your input and try again.",
  NotFound: "The requested item could not be found. Refresh and try again.",
  StorageUnavailable: "Storage is unavailable. Check disk space and permissions, then try again.",
  StorageCorrupt:
    "Saved data has an invalid format or version. Check your backup; the original file has not been overwritten.",
  WorkspaceUnavailable: "The execution workspace is unavailable. Check the project or reconnect.",
  ModelUnavailable: "The model is unavailable. Check its connection and configuration.",
  SandboxUnavailable:
    "The sandbox is unavailable. Check the environment or choose an available policy.",
  Busy: "Work is still in progress. Wait or stop the task before trying again.",
  RuntimeClosing: "Eta is shutting down. Reopen it and try again.",
  RecoveryRequired: "An unfinished task needs attention. Resume or stop it first.",
  "main.etaIsShuttingDown": "Eta is shutting down",
  "main.theAgentIsNotReadyYet": "The agent is not ready yet",
  "main.cannotLoadTheBackgroundTrayIcon": "Cannot load the background tray icon",
  "agentcredentials.cannotRead": "Cannot read {{value1}}",
  "agentcredentials.isNotValidJson": "{{value1}} is not valid JSON",
  "agentcredentials.mustBeAJsonObject": "{{value1}} must be a JSON object",
  "agentcredentials.invalidCredentialFormatForIn":
    "Invalid credential format for {{value2}} in {{value1}}",
  "agentsettings.mustBeAJsonObject": "{{value1}} must be a JSON object",
  "agentsettings.inMustBeANonEmptyString": "{{value2}} in {{value1}} must be a non-empty string",
  "agentsettings.invalidDefaultthinkinglevelIn": "Invalid defaultThinkingLevel in {{value1}}",
  "protocol.enterAUrlOrSearchQuery": "Enter a URL or search query",
  "protocol.theBrowserOnlySupportsHttpAndHttpsUrls":
    "The browser only supports HTTP and HTTPS URLs",
  "bootstrap.theBrowserIsUnavailable": "The browser is unavailable",
  "bootstrap.theFileManagerIsUnavailable": "The file manager is unavailable",
  "bootstrap.imageProcessingIsUnavailable": "Image processing is unavailable",
  "bootstrap.theImageFileExceeds32Mib": "The image file exceeds 32 MiB",
  "bot.enterAValidBotHttpOrHttpsAddress": "Enter a valid Bot HTTP or HTTPS address",
  "bot.enterTheBotAccessToken": "Enter the Bot access token",
  "bot.theBotForThisCloudProjectOrChat":
    "The Bot for this cloud project or chat is disconnected. Connect to the original Bot in Settings.",
  "bot.connectToABotFirst": "Connect to a Bot first",
  "bot.thisBotDoesNotSupportSandboxingUpdateIt":
    "This Bot does not support sandboxing. Update it and reconnect.",
  "bot.thisBotVersionDoesNotSupportThisFeature":
    "This Bot version does not support this feature. Update it and reconnect.",
  "bot.theBotDidNotProvideALiveMessage": "The Bot did not provide a live message stream",
  "bot.theBotConnectionWasInterruptedReconnecting":
    "The Bot connection was interrupted. Reconnecting.",
  "bot.theBotIsOfflineScheduledTasksCannotBe":
    "The Bot is offline. Scheduled tasks cannot be changed and existing schedules may still run.",
  "bot.thereAreNoClientModelCredentialsToImport": "There are no client model credentials to import",
  "bot.aChatCanOnlyMoveBetweenProjectsIn":
    "A chat can only move between projects in the same execution environment",
  "bot.cloudChatFilesAreStoredOnTheBot": "Cloud chat files are stored on the Bot",
  "windows.theBrowserWindowIsUnavailable": "The browser window is unavailable",
  "manager.theBrowserTabIsClosed": "The browser tab is closed",
  "manager.theBrowserWindowIsClosed": "The browser window is closed",
  "manager.theBrowserTabDoesNotExist": "The browser tab does not exist",
  "handlers.theUpdateServiceIsNotReadyYet": "The update service is not ready yet",
  "handlers.invalidUpdateAction": "Invalid update action",
  "handlers.invalidOpenMethod": "Invalid open method",
  "validation.invalidSessionId": "Invalid session ID",
  "updater.thereIsNoUpdateToInstall": "There is no update to install",
  "index.theSessionRootDirectoryCannotBeASymbolic":
    "The session root directory cannot be a symbolic link",
  "index.invalidStorageItem": "Invalid storage item",
  "index.invalidConfigurationFile": "Invalid configuration file",
  "index.theStorageItemIsOutsideTheApplicationData":
    "The storage item is outside the application data directory",
} as const;
