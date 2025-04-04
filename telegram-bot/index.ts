import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { fetchWithTimeout } from "./utils";
import {
    Aptos,
    AptosConfig,
    Account,
    Network,
    Ed25519PrivateKey,
    PrivateKey,
    PrivateKeyVariants,
} from "@aptos-labs/ts-sdk";
import WebSocket from "ws";
import { parseJSON } from "date-fns";

// Load environment variables
dotenv.config();

// Constants
const API_URL = process.env.API_URL || "https://plutus-move.onrender.com";
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error("BOT_TOKEN is missing in environment variables");
    process.exit(1);
}

const API_TIMEOUT = 1000000; // 10 seconds timeout for API calls

// Define types
interface Market {
    id: string;
    coinAddress: string;
    supplyApr: number;
    borrowApr: number;
    price: number;
    name?: string; // Added name for better display
    symbol?: string; // Added symbol for better display
    decimals?: number; // Added decimals for amount formatting
}

interface UserPosition {
    marketId: string;
    supplied: number;
    borrowed: number;
}

interface User {
    telegramId: number;
    walletAddress?: string;
    privateKey?: string; // Added private key field
}

// Update UserState type
type UserState =
    | "supply"
    | "withdraw"
    | "borrow"
    | "repay"
    | "connect_wallet"
    | "chat"
    | null;

// Add WebSocket connection management to SessionManager
class SessionManager {
    private userStates = new Map<number, UserState>();
    private userMarketSelections = new Map<number, Market[]>();
    private userCurrentMarket = new Map<number, Market>();
    private userWallets = new Map<number, string>();
    private userPrivateKeys = new Map<number, string>(); // Added to store private keys temporarily
    private userAmounts = new Map<number, number>();
    private userPayloads = new Map<number, any>();
    private userWebSockets = new Map<number, WebSocket>();

    // State management
    getState(chatId: number): UserState {
        return this.userStates.get(chatId) || null;
    }

    setState(chatId: number, state: UserState): void {
        this.userStates.set(chatId, state);
    }

    // Market management
    setMarkets(chatId: number, markets: Market[]): void {
        this.userMarketSelections.set(chatId, markets);
    }

    getMarkets(chatId: number): Market[] | undefined {
        return this.userMarketSelections.get(chatId);
    }

    setCurrentMarket(chatId: number, market: Market): void {
        this.userCurrentMarket.set(chatId, market);
    }

    getCurrentMarket(chatId: number): Market | undefined {
        return this.userCurrentMarket.get(chatId);
    }

    // Private key management
    setPrivateKey(chatId: number, privateKey: string): void {
        this.userPrivateKeys.set(chatId, privateKey);
    }

    getPrivateKey(chatId: number): string | undefined {
        return this.userPrivateKeys.get(chatId);
    }

    // Wallet address management (derived from private key)
    setWallet(chatId: number, address: string): void {
        this.userWallets.set(chatId, address);
    }

    getWallet(chatId: number): string | undefined {
        return this.userWallets.get(chatId);
    }

    // Amount management
    setAmount(chatId: number, amount: number): void {
        this.userAmounts.set(chatId, amount);
    }

    getAmount(chatId: number): number | undefined {
        return this.userAmounts.get(chatId);
    }

    // Payload management
    setPayload(chatId: number, payload: any): void {
        this.userPayloads.set(chatId, payload);
    }

    getPayload(chatId: number): any | undefined {
        return this.userPayloads.get(chatId);
    }

    // Add WebSocket management
    setWebSocket(chatId: number, ws: WebSocket): void {
        this.userWebSockets.set(chatId, ws);
    }

    getWebSocket(chatId: number): WebSocket | undefined {
        return this.userWebSockets.get(chatId);
    }

    closeWebSocket(chatId: number): void {
        const ws = this.userWebSockets.get(chatId);
        if (ws) {
            ws.close();
            this.userWebSockets.delete(chatId);
        }
    }

    // Clear private key after transaction completes
    clearPrivateKey(chatId: number): void {
        this.userPrivateKeys.delete(chatId);
    }

    // Update resetSession to include clearing private key
    resetSession(chatId: number): void {
        this.closeWebSocket(chatId);
        this.userStates.delete(chatId);
        this.userCurrentMarket.delete(chatId);
        this.userAmounts.delete(chatId);
        this.userPayloads.delete(chatId);
        this.clearPrivateKey(chatId);
        // Don't delete wallet address or markets as they can be reused
    }
}
// API Service
class PlutusAPI {
    private baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async getMarkets(): Promise<Market[]> {
        try {
            const response = await fetchWithTimeout(`${this.baseUrl}/api/markets`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
                timeout: API_TIMEOUT,
            });

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch markets: ${response.status} ${response.statusText}`
                );
            }

            return await response.json();
        } catch (error) {
            console.error("Market fetch error:", error);
            throw error;
        }
    }

    async getUserPositions(walletAddress: string): Promise<UserPosition[]> {
        try {
            const response = await fetchWithTimeout(
                `${this.baseUrl}/api/user/${walletAddress}/positions`,
                {
                    method: "GET",
                    headers: { "Content-Type": "application/json" },
                    timeout: API_TIMEOUT,
                }
            );

            if (!response.ok) {
                throw new Error(
                    `Failed to fetch user positions: ${response.status} ${response.statusText}`
                );
            }

            return await response.json();
        } catch (error) {
            console.error("User positions fetch error:", error);
            throw error;
        }
    }

    async createTransactionPayload(
        type: UserState,
        coinAddress: string,
        marketId: string,
        amount: number,
        walletAddress: string
    ): Promise<any> {
        try {
            const response = await fetchWithTimeout(
                `${this.baseUrl}/api/transaction/payload`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    timeout: API_TIMEOUT,
                    body: JSON.stringify({
                        type,
                        coinAddress,
                        market: marketId,
                        amount,
                        walletAddress,
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(
                    `Failed to create transaction payload: ${response.status} ${response.statusText}`
                );
            }

            return await response.json();
        } catch (error) {
            console.error("Transaction payload error:", error);
            throw error;
        }
    }
}

// UI Helper
class TelegramUI {
    private bot: TelegramBot;

    constructor(bot: TelegramBot) {
        this.bot = bot;
    }

    async startChatSession(chatId: number): Promise<void> {
        await this.bot.sendMessage(
            chatId,
            "*Chat Session Started*\n\nYou are now connected to the agent. Type your message or click 'End Chat' to finish.",
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔚 End Chat", callback_data: "end_chat" }],
                    ],
                },
            }
        );
    }

    async sendAgentMessage(chatId: number, message: string): Promise<void> {
        await this.bot.sendMessage(chatId, `🤖 *Agent:* ${message}`, {
            parse_mode: "Markdown",
        });
    }

    async sendMainMenu(
        chatId: number,
        walletConnected: boolean = false
    ): Promise<void> {
        const walletRow = walletConnected
            ? [{ text: "👛 My Wallet", callback_data: "wallet" }]
            : [{ text: "🔗 Connect Wallet", callback_data: "connect_wallet" }];

        const options = {
            reply_markup: {
                inline_keyboard: [
                    walletRow,
                    [{ text: "📊 Show Markets", callback_data: "markets" }],
                    [
                        { text: "💰 Supply Tokens", callback_data: "supply" },
                        { text: "🔄 Withdraw Tokens", callback_data: "withdraw" },
                    ],
                    [
                        { text: "💸 Borrow Tokens", callback_data: "borrow" },
                        { text: "💵 Repay Tokens", callback_data: "repay" },
                    ],
                    [{ text: "❓ Help", callback_data: "help" }],
                ],
            },
            parse_mode: "Markdown" as const,
        };

        await this.bot.sendMessage(
            chatId,
            "Welcome to the *Plutus Move Bot*!\nYour gateway to DeFi on the Move blockchain.",
            options
        );
    }

    async sendPrivateKeyConnectPrompt(chatId: number): Promise<void> {
        await this.bot.sendMessage(
            chatId,
            "Connect your Wallet with Private Key\n\n" +
            "Please enter your Move blockchain private key to connect your wallet:\n\n" +
            "⚠ IMPORTANT SECURITY NOTICE ⚠\n" +
            "• Your private key will ONLY be used for this transaction\n" +
            "• It will NOT be stored permanently anywhere\n" +
            "• It will be cleared from memory immediately after transaction\n" +
            "• For security, we recommend using a burner wallet with limited funds\n\n" +
            "Format: Enter private key without the '0x' prefix",
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "menu" }]],
                },
            }
        );
    }

    async sendWalletInfo(
        chatId: number,
        walletAddress: string,
        positions?: UserPosition[]
    ): Promise<void> {
        let message = `*Your Wallet*\n\nAddress: \`${walletAddress}\`\n\n`;

        if (positions && positions.length > 0) {
            message += "*Your Positions:*\n\n";
            positions.forEach((position) => {
                message += `Market: ${position.marketId}\n`;
                message += `Supplied: ${position.supplied}\n`;
                message += `Borrowed: ${position.borrowed}\n\n`;
            });
        } else {
            message += "You don't have any active positions yet.";
        }

        await this.bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu" }]],
            },
        });
    }

    async sendMarketsList(
        chatId: number,
        markets: Market[],
        initialAction: UserState = null
    ): Promise<void> {
        let message = "*Available Markets:*\n\n";

        markets.forEach((market, index) => {
            const name = market.name || `Market #${index + 1}`;
            const symbol = market.symbol ? ` (${market.symbol})` : "";

            message += `*${name}${symbol}*\n`;
            message += `ID: \`${market.id}\`\n`;
            message += `Coin Address: \`${market.coinAddress}\`\n`;
            message += `Supply APR: ${market.supplyApr}%\n`;
            message += `Borrow APR: ${market.borrowApr}%\n`;
            message += `Price: $${market.price.toFixed(2)}\n\n`;
        });

        // Create action buttons for each market based on the initial action
        const marketButtons = [];

        if (initialAction === "supply") {
            markets.forEach((market, index) => {
                const name = market.name || `Market #${index + 1}`;
                marketButtons.push([
                    { text: `Supply to ${name}`, callback_data: `s_${index}` },
                ]);
            });
        } else if (initialAction === "borrow") {
            markets.forEach((market, index) => {
                const name = market.name || `Market #${index + 1}`;
                marketButtons.push([
                    { text: `Borrow from ${name}`, callback_data: `b_${index}` },
                ]);
            });
        } else if (initialAction === "withdraw") {
            markets.forEach((market, index) => {
                const name = market.name || `Market #${index + 1}`;
                marketButtons.push([
                    { text: `Withdraw from ${name}`, callback_data: `w_${index}` },
                ]);
            });
        } else if (initialAction === "repay") {
            markets.forEach((market, index) => {
                const name = market.name || `Market #${index + 1}`;
                marketButtons.push([
                    { text: `Repay to ${name}`, callback_data: `r_${index}` },
                ]);
            });
        } else {
            // Show all options in a more compact format
            markets.forEach((market, index) => {
                const name = market.name || `Market #${index + 1}`;
                marketButtons.push([
                    { text: `${name} - Supply`, callback_data: `s_${index}` },
                    { text: `${name} - Borrow`, callback_data: `b_${index}` },
                ]);
            });
        }

        // Add back button
        marketButtons.push([{ text: "🔙 Back to Menu", callback_data: "menu" }]);

        await this.bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: marketButtons },
        });
    }

    async sendTransactionForm(
        chatId: number,
        action: UserState,
        market: Market
    ): Promise<void> {
        // Format better titles for actions
        const actionTitles = {
            supply: "Supply",
            withdraw: "Withdraw",
            borrow: "Borrow",
            repay: "Repay",
        };

        const name = market.name || market.id;
        const actionTitle =
            action && actionTitles[action as keyof typeof actionTitles]
                ? actionTitles[action as keyof typeof actionTitles]
                : "Unknown Action";
        const aprType =
            action === "supply" || action === "withdraw" ? "Supply" : "Borrow";
        const aprValue =
            action === "supply" || action === "withdraw"
                ? market.supplyApr
                : market.borrowApr;

        let message = `*${actionTitle} Tokens to ${name}*\n\n`;
        message += `Market ID: \`${market.id}\`\n`;
        message += `Coin Address: \`${market.coinAddress}\`\n`;

        if (action === "supply" || action === "borrow") {
            message += `Current ${aprType} APR: ${aprValue}%\n\n`;
        }

        if (action) {
            message += `Please enter the amount you wish to ${action.toLowerCase()}:`;
        } else {
            message += `Action is not specified. Please try again.`;
        }

        await this.bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔙 Back to Markets", callback_data: "markets" }],
                ],
            },
        });
    }

    async sendTransactionConfirmation(
        chatId: number,
        action: UserState,
        market: Market,
        amount: number,
        payload: any
    ): Promise<void> {
        const name = market.name || market.id;
        const actionTitle = action
            ? action.charAt(0).toUpperCase() + action.slice(1)
            : "Unknown Action";

        let message = `*${actionTitle} Transaction Confirmation*\n\n`;
        message += `Market: ${name}\n`;
        message += `Amount: ${amount}\n\n`;
        message += `*Transaction Payload:*\n\`\`\`json\n${JSON.stringify(
            payload,
            null,
            2
        )}\n\`\`\``;

        await this.bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✅ Confirm Transaction", callback_data: "confirm" }],
                    [{ text: "❌ Cancel", callback_data: "menu" }],
                ],
            },
        });
    }

    // Update sendTransaction to use the provided private key
    async sendTransaction(payload: any, privateKey: string): Promise<string> {
        try {
            console.log("Transaction Started");
            const config = new AptosConfig({ network: Network.TESTNET });
            const aptos = new Aptos(config);

            // Use the provided private key instead of a hardcoded one
            const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

            const account = await aptos.deriveAccountFromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(
                        formattedKey,
                        PrivateKeyVariants.Ed25519
                    )
                ),
            });

            console.log("Account address:", account.accountAddress.toString());
            console.log("Payload", payload);

            const txn = await aptos.transaction.build.simple({
                sender: account.accountAddress,
                data: {
                    typeArguments: payload.typeArguments,
                    functionArguments: payload.functionArguments,
                    function: payload.function
                },
            });

            console.log("Transaction built:", txn);

            const committedTxn = await aptos.signAndSubmitTransaction({
                signer: account,
                transaction: txn,
            });

            console.log("Transaction submitted:", committedTxn);
            const executedTransaction = await aptos.waitForTransaction({
                transactionHash: committedTxn.hash,
            });
            return executedTransaction.hash;
        } catch (error) {
            console.error('Error sending transaction:', error);
            throw new Error('Failed to send transaction: ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    async sendErrorMessage(chatId: number, errorMessage: string): Promise<void> {
        await this.bot.sendMessage(chatId, `❌ *Error:* ${errorMessage}`, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu" }]],
            },
        });
    }

    async sendHelpMessage(chatId: number): Promise<void> {
        const helpMessage =
            "*Plutus Move Bot Help*\n\n" +
            "This bot allows you to interact with the Plutus protocol on the Move blockchain.\n\n" +
            "*Available Commands:*\n\n" +
            "• */start* - Show the main menu\n" +
            "• */help* - Show this help message\n\n" +
            "*Main Features:*\n\n" +
            "• *Connect Wallet* - Link your Move blockchain wallet\n" +
            "• *Show Markets* - View all available markets\n" +
            "• *Supply* - Provide liquidity to earn interest\n" +
            "• *Withdraw* - Remove your supplied assets\n" +
            "• *Borrow* - Take a loan using your collateral\n" +
            "• *Repay* - Pay back borrowed assets\n\n" +
            "*How to use:*\n\n" +
            "1. Connect your wallet\n" +
            "2. Select an action from the menu\n" +
            "3. Choose a market\n" +
            "4. Enter the amount\n" +
            "5. Confirm the transaction\n\n" +
            "For more information, visit our website or contact support.";

        await this.bot.sendMessage(chatId, helpMessage, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu" }]],
            },
        });
    }

    async sendWalletConnectPrompt(chatId: number): Promise<void> {
        await this.bot.sendMessage(
            chatId,
            "*Connect your Wallet*\n\nPlease enter your Move blockchain wallet address to connect it to the bot:",
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "menu" }]],
                },
            }
        );
    }

    async sendSuccessMessage(chatId: number, message: string): Promise<void> {
        await this.bot.sendMessage(chatId, `✅ *Success:* ${message}`, {
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu" }]],
            },
        });
    }
}

// Main Bot class
class PlutusBot {
    private bot: TelegramBot;
    private sessionManager: SessionManager;
    private api: PlutusAPI;
    private ui: TelegramUI;

    constructor(token: string, apiUrl: string) {
        this.bot = new TelegramBot(token, { polling: true });
        this.sessionManager = new SessionManager();
        this.api = new PlutusAPI(apiUrl);
        this.ui = new TelegramUI(this.bot);

        this.setupEventHandlers();

        // Error handler
        process.on("uncaughtException", (error) => {
            console.error("Uncaught Exception:", error);
        });
    }

    private async handleMessage(msg: TelegramBot.Message): Promise<void> {
        if (!msg.text || msg.text.startsWith('/')) {
            return;
        }

        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const state = this.sessionManager.getState(chatId);

        if (!state) {
            return;
        }

        try {
            if (state === 'connect_wallet') {
                await this.handlePrivateKeyConnection(chatId, text);
            } else if (state === 'supply' || state === 'withdraw' || state === 'borrow' || state === 'repay') {
                await this.handleAmountInput(chatId, text, state);
            } else if (state === "chat") {
                const ws = this.sessionManager.getWebSocket(chatId);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.log("Sending message to agent:", text);
                    ws.send(JSON.stringify({ content: text }));
                } else {
                    console.log("WebSocket not available, reinitializing chat session");
                    await this.initiateChatSession(chatId);
                    const newWs = this.sessionManager.getWebSocket(chatId);
                    if (newWs && newWs.readyState === WebSocket.OPEN) {
                        newWs.send(JSON.stringify({ content: text }));
                    } else {
                        await this.ui.sendErrorMessage(
                            chatId,
                            "Unable to establish chat connection. Please try again later."
                        );
                        this.sessionManager.resetSession(chatId);
                    }
                }
            }
        } catch (error) {
            console.error('Error handling message:', error);
            await this.ui.sendErrorMessage(chatId, 'An unexpected error occurred. Please try again.');
        }
    }

    private setupEventHandlers(): void {
        // Command handlers
        this.bot.onText(/\/start/, this.handleStartCommand.bind(this));
        this.bot.onText(/\/help/, this.handleHelpCommand.bind(this));

        // Callback query handler
        this.bot.on("callback_query", this.handleCallbackQuery.bind(this));

        // Message handler
        this.bot.on("message", this.handleMessage.bind(this));
        this.bot.onText(/\/chat/, this.handleChatCommand.bind(this));
    }

    private async handlePrivateKeyConnection(chatId: number, privateKey: string): Promise<void> {
        // Basic validation - in real app, would need stronger validation
        if (!privateKey || privateKey.length < 10) {
            await this.ui.sendErrorMessage(chatId, 'Please enter a valid private key.');
            return;
        }

        try {
            // Format the private key if needed
            const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

            // Derive the wallet address from the private key
            const config = new AptosConfig({ network: Network.TESTNET });
            const aptos = new Aptos(config);

            const account = await aptos.deriveAccountFromPrivateKey({
                privateKey: new Ed25519PrivateKey(
                    PrivateKey.formatPrivateKey(
                        formattedKey,
                        PrivateKeyVariants.Ed25519
                    )
                ),
            });

            const walletAddress = account.accountAddress.toString();

            // Store private key and wallet address
            this.sessionManager.setPrivateKey(chatId, formattedKey);
            this.sessionManager.setWallet(chatId, walletAddress);

            await this.ui.sendSuccessMessage(
                chatId,
                `Your wallet has been connected successfully!\nAddress: ${walletAddress}\n\n⚠️ Your private key is temporarily stored for this session only and will be cleared after transaction or when you exit.`
            );

            // Check if there was an intended action from before
            const savedPayload = this.sessionManager.getPayload(chatId);
            if (savedPayload && savedPayload.intendedAction) {
                const action = savedPayload.intendedAction as UserState;
                // Clear the temporary payload
                this.sessionManager.setPayload(chatId, null);
                // Now process the intended action
                await this.handleShowMarkets(chatId, action);
            } else {
                // No pending action, reset state and show main menu
                this.sessionManager.setState(chatId, null);
                await this.ui.sendMainMenu(chatId, true);
            }
        } catch (error) {
            console.error('Error processing private key:', error);
            await this.ui.sendErrorMessage(
                chatId,
                'Invalid private key format. Please ensure you are entering a valid Ed25519 private key for the Move blockchain.'
            );
        }
    }
    private async handleChatCommand(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id;
        await this.initiateChatSession(chatId);
    }
    private async initiateChatSession(chatId: number): Promise<void> {
        try {
            // Close any existing WebSocket connection for this chat
            const existingWs = this.sessionManager.getWebSocket(chatId);
            if (existingWs) {
                existingWs.removeAllListeners();
                existingWs.close();
                this.sessionManager.resetSession(chatId);
            }
            const ws = new WebSocket("wss://plutus-move-agent.onrender.com");

            // Store the WebSocket immediately so we can track it
            this.sessionManager.setWebSocket(chatId, ws);
            this.sessionManager.setState(chatId, "chat");

            let isConnected = false;
            let connectionTimeout: NodeJS.Timeout | null = null;

            const cleanup = () => {
                if (connectionTimeout) {
                    clearTimeout(connectionTimeout);
                }
                if (!isConnected && ws) {
                    ws.removeAllListeners();
                    ws.close();
                }
            };

            // Add a timeout to handle connection issues
            connectionTimeout = setTimeout(() => {
                if (!isConnected) {
                    console.log("WebSocket connection timeout");
                    cleanup();
                    this.ui.sendErrorMessage(
                        chatId,
                        "Connection to agent timed out. Please try again later."
                    );
                    this.sessionManager.resetSession(chatId);
                }
            }, 15000); // 15 seconds timeout

            ws.on("open", async () => {
                isConnected = true;
                clearTimeout(connectionTimeout);
                console.log("WebSocket connection established");
                await this.ui.startChatSession(chatId);
            })


            ws.on("message", async (data) => {
                try {
                    const message = data.toString();
                    console.log("Received message from agent:", message);

                    // Try to parse as JSON first
                    try {
                        const jsonData = JSON.parse(message);
                        if (jsonData.type === "error") {
                            await this.ui.sendErrorMessage(chatId, jsonData.content);
                        } else {
                            await this.ui.sendAgentMessage(chatId, jsonData.content);
                        }
                    } catch (jsonError) {
                        // If not JSON, treat as plain text
                        await this.ui.sendAgentMessage(chatId, message);
                    }
                } catch (error) {
                    console.error("Error processing WebSocket message:", error);
                    await this.ui.sendErrorMessage(
                        chatId,
                        "Error processing agent response. Please try again."
                    );
                }
            })

            ws.on("error", async (error) => {
                console.error("WebSocket error:", error);
                cleanup();
                if (!isConnected) {
                    await this.ui.sendErrorMessage(
                        chatId,
                        "Failed to connect to agent. Please try again later."
                    );
                } else {
                    await this.ui.sendErrorMessage(
                        chatId,
                        "Connection to agent was lost. Please try again."
                    );
                }
                this.sessionManager.resetSession(chatId);
            })




            ws.on("close", async () => {
                console.log("WebSocket connection closed");
                cleanup();
                if (!isConnected) return;
                await this.bot.sendMessage(chatId, "Chat session ended.");
                this.sessionManager.resetSession(chatId);
            })
        } catch (error) {
            console.error("Error initiating chat session:", error);
            await this.ui.sendErrorMessage(
                chatId,
                "Failed to start chat session. Please try again later."
            );
            this.sessionManager.resetSession(chatId);
        }
    }

    private async handleStartCommand(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id;
        const wallet = this.sessionManager.getWallet(chatId);
        await this.ui.sendMainMenu(chatId, !!wallet);
    }

    private async handleHelpCommand(msg: TelegramBot.Message): Promise<void> {
        const chatId = msg.chat.id;
        await this.ui.sendHelpMessage(chatId);
    }

    private async handleCallbackQuery(
        callbackQuery: TelegramBot.CallbackQuery
    ): Promise<void> {
        const chatId = callbackQuery.message?.chat.id;
        if (!chatId) {
            console.error("Callback query message or chat ID is undefined.");
            return;
        }

        const data = callbackQuery.data;
        if (!data) {
            console.error("Callback data is undefined.");
            return;
        }

        console.log(`Received callback data: ${data}`);

        // Acknowledge the button click
        try {
            await this.bot.answerCallbackQuery(callbackQuery.id);
        } catch (error) {
            console.error("Error answering callback query:", error);
        }

        // Process the callback data
        await this.processCallbackData(chatId, data);
    }

    private async processCallbackData(chatId: number, data: string): Promise<void> {
        try {
            // Standard menu actions
            if (data === 'markets') {
                await this.handleShowMarkets(chatId);
            }
            else if (data === 'supply' || data === 'withdraw' || data === 'borrow' || data === 'repay') {
                // Check if private key is already stored
                if (!this.sessionManager.getPrivateKey(chatId)) {
                    // Set the state for later processing after private key input
                    this.sessionManager.setState(chatId, 'connect_wallet');
                    // Store intended action
                    this.sessionManager.setPayload(chatId, { intendedAction: data });
                    await this.ui.sendPrivateKeyConnectPrompt(chatId);
                } else {
                    await this.handleShowMarkets(chatId, data as UserState);
                }
            }
            else if (data === 'menu') {
                this.sessionManager.resetSession(chatId);
                const wallet = this.sessionManager.getWallet(chatId);
                await this.ui.sendMainMenu(chatId, !!wallet);
            }
            else if (data === 'help') {
                await this.ui.sendHelpMessage(chatId);
            }
            else if (data === 'connect_wallet') {
                this.sessionManager.setState(chatId, 'connect_wallet');
                await this.ui.sendPrivateKeyConnectPrompt(chatId);
            }
            else if (data === 'wallet') {
                await this.handleWalletInfo(chatId);
            }
            // Market-specific actions
            else if (data.startsWith('s_') || data.startsWith('b_') ||
                data.startsWith('w_') || data.startsWith('r_')) {
                await this.handleMarketSelection(chatId, data);
            }
            else if (data === 'confirm') {
                await this.handleTransactionConfirmation(chatId);
            } else if (data === 'end_chat'){
                const ws = this.sessionManager.getWebSocket(chatId);
                if (ws) {
                    ws.close();
                    this.sessionManager.resetSession(chatId);
                    const wallet = this.sessionManager.getWallet(chatId);
                    await this.ui.sendMainMenu(chatId, !!wallet);
                }
                await this.bot.sendMessage(chatId, "Chat session ended.");
            }
            else {
                console.log(`Unknown callback data: ${data}`);
            }
        } catch (error) {
            console.error('Error processing callback:', error);
            await this.ui.sendErrorMessage(chatId, 'An unexpected error occurred. Please try again.');
        }
    }


    private async handleWalletConnection(
        chatId: number,
        walletAddress: string
    ): Promise<void> {
        // Basic validation - in real app, would need stronger validation
        if (!walletAddress || walletAddress.length < 10) {
            await this.ui.sendErrorMessage(
                chatId,
                "Please enter a valid wallet address."
            );
            return;
        }

        // Store wallet address
        this.sessionManager.setWallet(chatId, walletAddress);
        this.sessionManager.setState(chatId, null);

        await this.ui.sendSuccessMessage(
            chatId,
            `Your wallet has been connected successfully!\nAddress: ${walletAddress}`
        );

        // Show main menu after connecting wallet
        await this.ui.sendMainMenu(chatId, true);
    }

    private async handleWalletInfo(chatId: number): Promise<void> {
        const walletAddress = this.sessionManager.getWallet(chatId);

        if (!walletAddress) {
            this.sessionManager.setState(chatId, "connect_wallet");
            await this.ui.sendWalletConnectPrompt(chatId);
            return;
        }

        try {
            const positions = await this.api.getUserPositions(walletAddress);
            await this.ui.sendWalletInfo(chatId, walletAddress, positions);
        } catch (error) {
            console.error("Error fetching wallet info:", error);
            await this.ui.sendWalletInfo(chatId, walletAddress);
        }
    }

    private async handleShowMarkets(
        chatId: number,
        initialAction: UserState = null
    ): Promise<void> {
        try {
            // Check if wallet is connected for supply/withdraw/borrow/repay actions
            if (initialAction && !this.sessionManager.getWallet(chatId)) {
                this.sessionManager.setState(chatId, "connect_wallet");
                await this.ui.sendErrorMessage(
                    chatId,
                    `You need to connect your wallet first to ${initialAction} tokens.`
                );
                await this.ui.sendWalletConnectPrompt(chatId);
                return;
            }

            const markets = await this.api.getMarkets();

            if (!markets || markets.length === 0) {
                await this.ui.sendErrorMessage(
                    chatId,
                    "No markets available at the moment."
                );
                return;
            }

            // Enhance market data with names if not provided by API
            const enhancedMarkets = markets.map((market, index) => ({
                ...market,
                name: market.name || `Market ${index + 1}`,
                symbol: market.symbol || "",
            }));

            // Store markets for later use
            this.sessionManager.setMarkets(chatId, enhancedMarkets);

            // Set initial action if provided
            if (initialAction) {
                this.sessionManager.setState(chatId, initialAction);
            }

            await this.ui.sendMarketsList(chatId, enhancedMarkets, initialAction);
        } catch (error) {
            console.error("Error showing markets:", error);
            await this.ui.sendErrorMessage(
                chatId,
                "Failed to fetch market data. Please try again later."
            );
        }
    }

    private async handleMarketSelection(
        chatId: number,
        data: string
    ): Promise<void> {
        const actionCode = data.charAt(0);
        const marketIndex = parseInt(data.substring(2));
        const markets = this.sessionManager.getMarkets(chatId);

        if (!markets || marketIndex >= markets.length) {
            await this.ui.sendErrorMessage(
                chatId,
                "Invalid market selection. Please try again."
            );
            return;
        }

        const selectedMarket = markets[marketIndex];
        this.sessionManager.setCurrentMarket(chatId, selectedMarket);

        // Map action code to state
        const actionMap: { [key: string]: UserState } = {
            s: "supply",
            b: "borrow",
            w: "withdraw",
            r: "repay",
        };

        const action = actionMap[actionCode];
        if (!action) {
            await this.ui.sendErrorMessage(
                chatId,
                "Invalid action. Please try again."
            );
            return;
        }

        this.sessionManager.setState(chatId, action);
        await this.ui.sendTransactionForm(chatId, action, selectedMarket);
    }

    private async handleAmountInput(
        chatId: number,
        amountStr: string,
        state: UserState
    ): Promise<void> {
        // Parse and validate amount
        const amount = parseFloat(amountStr);

        if (isNaN(amount) || amount <= 0) {
            await this.ui.sendErrorMessage(
                chatId,
                "Please enter a valid positive number for the amount."
            );
            return;
        }

        const selectedMarket = this.sessionManager.getCurrentMarket(chatId);
        const walletAddress = this.sessionManager.getWallet(chatId);

        if (!selectedMarket) {
            await this.ui.sendErrorMessage(
                chatId,
                "Market selection error. Please try again."
            );
            return;
        }

        if (!walletAddress) {
            this.sessionManager.setState(chatId, "connect_wallet");
            await this.ui.sendWalletConnectPrompt(chatId);
            return;
        }

        try {
            // Store amount for confirmation step
            this.sessionManager.setAmount(chatId, amount);

            // Generate transaction payload
            const response = await this.api.createTransactionPayload(
                state,
                selectedMarket.coinAddress,
                selectedMarket.id,
                amount,
                walletAddress
            );
            console.log("payload:", response.payload);
            // Store payload for confirmation step
            this.sessionManager.setPayload(chatId, response.payload);

            await this.ui.sendTransactionConfirmation(
                chatId,
                state,
                selectedMarket,
                amount,
                response.payload
            );
        } catch (error) {
            console.error("Transaction error:", error);
            await this.ui.sendErrorMessage(
                chatId,
                `Error creating ${state} transaction. Please try again later.`
            );
        }
    }

    private async handleTransactionConfirmation(chatId: number): Promise<void> {
        console.log("Transaction Confirmation Started");
        const state = this.sessionManager.getState(chatId);
        const market = this.sessionManager.getCurrentMarket(chatId);
        const amount = this.sessionManager.getAmount(chatId);
        const payload = this.sessionManager.getPayload(chatId);
        const privateKey = this.sessionManager.getPrivateKey(chatId);

        console.log("Payload:", payload);

        if (!state || !market || !amount || !payload) {
            await this.ui.sendErrorMessage(chatId, 'Transaction details missing. Please try again.');
            return;
        }

        if (!privateKey) {
            this.sessionManager.setState(chatId, 'connect_wallet');
            await this.ui.sendPrivateKeyConnectPrompt(chatId);
            return;
        }

        try {
            // Send a message to reassure the user about private key security
            await this.bot.sendMessage(
                chatId,
                "🔐 *Processing Transaction*\n\nYour private key is being used only for this transaction and will be cleared from memory immediately afterward.",
                { parse_mode: 'Markdown' }
            );

            // Submit the transaction to the blockchain using the private key
            const txHash = await this.ui.sendTransaction(payload, privateKey);

            await this.ui.sendSuccessMessage(
                chatId,
                `Your ${state} transaction of ${amount} tokens has been submitted successfully!\nTransaction Hash: ${txHash}\n\n✅ Your private key has been cleared from memory.`
            );

            // Reset user state and explicitly clear the private key
            this.sessionManager.clearPrivateKey(chatId);
            this.sessionManager.resetSession(chatId);
        } catch (error) {
            console.error('Transaction submission error:', error);
            await this.ui.sendErrorMessage(
                chatId,
                `Failed to submit transaction: ${error instanceof Error ? error.message : 'Unknown error'}`
            );

            // Still clear private key even in case of error
            this.sessionManager.clearPrivateKey(chatId);
        }
    }
}

// Run the bot
try {
    const bot = new PlutusBot(BOT_TOKEN, API_URL);
    console.log("Plutus Move Telegram Bot is running...");
} catch (error) {
    console.error("Failed to start the bot:", error);
    process.exit(1);
}