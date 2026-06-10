import * as puppeteer from 'puppeteer';
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import UserAgent from "user-agents";
import { Server } from "proxy-chain";
import { IGpassword, IGusername } from "../../secret";
import logger from "../../config/logger";
import { Instagram_cookiesExist, loadCookies, saveCookies, getIgDailyState, incrementIgDailyCount, getIgCooldown, setIgCooldown } from "../../utils";
import { getIgProfile } from "../../config/igProfile";
import { setLastRunSummary } from "../../utils/igRunSummary";
import { getCommentFilterConfig, shouldSkipComment } from "../../utils/commentFilters";
import { runAgent } from "../../Agent";
import { getInstagramCommentSchema } from "../../Agent/schema";
import readline from "readline";
import fs from "fs/promises";
import { getShouldExitInteractions } from '../../api/agent';

// Add stealth plugin to puppeteer
puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(
  AdblockerPlugin({
    // Optionally enable Cooperative Mode for several request interceptors
    interceptResolutionPriority: puppeteer.DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
  })
);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class IgClient {
    private browser: puppeteer.Browser | null = null;
    private page: puppeteer.Page | null = null;
    private username: string;
    private password: string;

    constructor(username?: string, password?: string) {
        this.username = username || '';
        this.password = password || '';
    }

    async init() {
        // const server = new Server({ port: 8000 });
        // await server.listen();
        // const proxyUrl = server.getProxyUrl();
        // logger.info(`Using proxy URL: ${proxyUrl}`);

        // Center the window on a 1920x1080 screen
        const width = 1280;
        const height = 800;
        const screenWidth = 1920;
        const screenHeight = 1080;
        const left = Math.floor((screenWidth - width) / 2);
        const top = Math.floor((screenHeight - height) / 2);
        this.browser = await puppeteerExtra.launch({
            headless: false,
            args: [
                `--window-size=${width},${height}`,
                `--window-position=${left},${top}`
            ],
        });
        this.page = await this.browser.newPage();
        const userAgent = new UserAgent({ deviceCategory: "desktop" });
        await this.page.setUserAgent(userAgent.toString());
        await this.page.setViewport({ width, height });

        if (await Instagram_cookiesExist()) {
            await this.loginWithCookies();
        } else {
            await this.loginWithCredentials();
        }
    }

    private async loginWithCookies() {
        if (!this.page) throw new Error("Page not initialized");
        const cookies = await loadCookies("./cookies/Instagramcookies.json");
        if (cookies.length > 0) {
            // browser.setCookie honors partitionKey (page.setCookie drops it),
            // which sessionid needs to actually restore the session.
            if (this.browser) {
                await this.browser.setCookie(...cookies);
            } else {
                await this.page.setCookie(...cookies);
            }
        } else {
            logger.warn("No valid cookies found. Falling back to credentials login.");
            await this.loginWithCredentials();
            return;
        }
        
        logger.info("Loaded cookies. Navigating to Instagram home page.");
        try {
            await this.page.goto("https://www.instagram.com/", {
                waitUntil: "networkidle2",
            });
            const url = this.page.url();
            if (url.includes("/login/")) {
                logger.warn("Cookies are invalid or expired. Falling back to credentials login.");
                await this.loginWithCredentials();
            } else {
                logger.info("Successfully logged in with cookies.");
                // Refresh the saved jar (complete set incl. sessionid) so it
                // stays valid across restarts.
                try {
                    const fresh = await this.getAllInstagramCookies();
                    await saveCookies("./cookies/Instagramcookies.json", fresh);
                } catch { /* non-fatal */ }
            }
        } catch (error) {
            logger.warn("Login with cookies failed. Falling back to credentials login.");
            await this.loginWithCredentials();
        }
    }

    private async dismissCookieConsent(): Promise<void> {
        if (!this.page) return;
        // Instagram shows an EU/region cookie-consent wall that covers the login form.
        // Click the "allow" button (matched across EN + PL) before touching the form.
        const consentTexts = [
            "allow all cookies",
            "allow all",
            "accept all",
            "zezwól na wszystkie pliki cookie",
            "zezwól na wszystkie",
            "zezwalaj na wszystkie pliki cookie",
            "akceptuj wszystkie",
        ];
        try {
            const clicked = await this.page.evaluate((texts) => {
                const candidates = Array.from(
                    document.querySelectorAll('button, div[role="button"]')
                );
                for (const el of candidates) {
                    const label = (el.textContent || "").trim().toLowerCase();
                    if (texts.some((t) => label === t || label.includes(t))) {
                        (el as HTMLElement).click();
                        return label;
                    }
                }
                return null;
            }, consentTexts);
            if (clicked) {
                logger.info(`Dismissed cookie consent dialog ("${clicked}").`);
                await delay(2000);
            }
        } catch (e) {
            logger.warn("Cookie consent check failed (continuing).");
        }
    }

    // Instagram's `sessionid` is a CHIPS-partitioned cookie: page.cookies()
    // and CDP Network.getAllCookies never return it, so a jar saved through
    // them can't restore the session. browser.cookies() (Puppeteer >=22) is
    // the only API that includes partitioned cookies (with partitionKey).
    private async getAllInstagramCookies(): Promise<any[]> {
        if (!this.page) return [];
        try {
            if (this.browser) {
                const all = await this.browser.cookies();
                const ig = all.filter(
                    (c: any) => typeof c.domain === "string" && c.domain.includes("instagram.com")
                );
                if (ig.some((c: any) => c.name === "sessionid")) return ig;
                logger.warn("browser.cookies() returned no sessionid; trying CDP fallback.");
            }
            const cdp = await this.page.target().createCDPSession();
            const { cookies } = await cdp.send("Network.getAllCookies");
            const mapped = (cookies || [])
                .filter((c: any) => typeof c.domain === "string" && c.domain.includes("instagram.com"))
                .map((c: any) => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path,
                    expires: c.expires && c.expires > 0 ? c.expires : undefined,
                    httpOnly: c.httpOnly,
                    secure: c.secure,
                    sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : undefined,
                }));
            if (mapped.length > 0) return mapped;
        } catch (e) {
            logger.warn("Cookie collection failed, falling back to page.cookies().");
        }
        return this.page.cookies();
    }

    // Instagram increasingly gates automated logins behind reCAPTCHA / a
    // checkpoint challenge. Because the browser is non-headless, the user can
    // solve it in the visible window — poll until we land back on a normal page.
    private async waitForManualChallengeResolution(maxWaitMs = 180000): Promise<boolean> {
        if (!this.page) return false;
        const isChallenge = () => {
            const url = this.page!.url();
            return url.includes("/auth_platform/recaptcha") ||
                url.includes("/challenge") ||
                url.includes("/accounts/login") ||
                url.includes("/two_factor");
        };
        if (!isChallenge()) return true;
        logger.warn("Instagram presented a reCAPTCHA/challenge. Waiting up to 3 min for manual resolution in the open browser window...");
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            await delay(3000);
            if (!isChallenge()) {
                logger.info("Challenge resolved — continuing.");
                await delay(2000);
                return true;
            }
        }
        logger.error("Challenge was not resolved within the timeout.");
        return false;
    }

    private async loginWithCredentials(retry = false): Promise<void> {
        if (!this.username || !this.password) {
            throw new Error("Instagram credentials are required for login.");
        }
        if (!this.page || !this.browser) throw new Error("Browser/Page not initialized");
        try {
            logger.info("Logging in with credentials...");
            await this.page.goto("https://www.instagram.com/accounts/login/", {
                waitUntil: "networkidle2",
            });
            await this.dismissCookieConsent();
            // Instagram serves multiple login form variants: legacy uses
            // name="username"/"password"/button[submit], the redesign uses
            // name="email"/"pass"/input[submit]. Match both.
            const userSel = 'input[name="username"], input[name="email"]';
            const passSel = 'input[name="password"], input[name="pass"]';
            await this.page.waitForSelector(userSel, { timeout: 30000 });
            await this.page.type(userSel, this.username);
            await this.page.type(passSel, this.password);
            // The visible "Log in" button is a div[role=button] in the redesign and
            // the real input[type=submit] is hidden/unclickable, so submit the form
            // by pressing Enter from the (focused) password field instead.
            await this.page.keyboard.press("Enter");
            await this.page.waitForNavigation({ waitUntil: "networkidle2" });
            // If IG threw up a reCAPTCHA/checkpoint, give the user a chance to
            // solve it in the visible window before we bail.
            await this.waitForManualChallengeResolution();
            const cookies = await this.getAllInstagramCookies();
            await saveCookies("./cookies/Instagramcookies.json", cookies);
            logger.info("Successfully logged in and saved cookies.");
            await this.handleNotificationPopup();
        } catch (error) {
            // Capture what Instagram actually showed so login failures are diagnosable.
            try {
                if (this.page) {
                    await this.page.screenshot({ path: "./cookies/login-debug.png", fullPage: true });
                    logger.warn(`Login failed on URL: ${this.page.url()} — saved screenshot to cookies/login-debug.png`);
                }
            } catch { /* ignore screenshot errors */ }
            if (!retry) {
                logger.warn("Login with credentials failed. Retrying once...");
                await delay(5000);
                return this.loginWithCredentials(true);
            }
            throw error;
        }
    }

    async handleNotificationPopup() {
        if (!this.page) throw new Error("Page not initialized");
        console.log("Checking for notification popup...");

        try {
            // Wait for the dialog to appear, with a timeout
            const dialogSelector = 'div[role="dialog"]';
            await this.page.waitForSelector(dialogSelector, { timeout: 5000 });
            const dialog = await this.page.$(dialogSelector);

            if (dialog) {
                console.log("Notification dialog found. Searching for 'Not Now' button.");
                const notNowButtonSelectors = ["button", `div[role="button"]`];
                let notNowButton: puppeteer.ElementHandle<Element> | null = null;

                for (const selector of notNowButtonSelectors) {
                    // Search within the dialog context
                    const elements = await dialog.$$(selector);
                    for (const element of elements) {
                        try {
                            const text = await element.evaluate((el) => el.textContent);
                            if (text && text.trim().toLowerCase() === "not now") {
                                notNowButton = element;
                                console.log(`Found 'Not Now' button with selector: ${selector}`);
                                break;
                            }
                        } catch (e) {
                            // Ignore errors from stale elements
                        }
                    }
                    if (notNowButton) break;
                }

                if (notNowButton) {
                    try {
                        console.log("Dismissing 'Not Now' notification popup...");
                        // Using evaluate to click because it can be more reliable
                        await notNowButton.evaluate((btn:any) => btn.click());
                        await delay(1500); // Wait for popup to close
                        console.log("'Not Now' notification popup dismissed.");
                    } catch (e) {
                        console.warn("Failed to click 'Not Now' button. It might be gone or covered.", e);
                    }
                } else {
                    console.log("'Not Now' button not found within the dialog.");
                }
            }
        } catch (error) {
            console.log("No notification popup appeared within the timeout period.");
            // If it times out, it means no popup, which is fine.
        }
    }

    private async isOnLoginOrChallenge(): Promise<boolean> {
        if (!this.page) return true;
        const url = this.page.url();
        return (
            url.includes("/accounts/login") ||
            url.includes("/challenge") ||
            url.includes("/accounts/onetap") ||
            url.includes("/accounts/suspended") ||
            url.includes("/accounts/blocked")
        );
    }

    async ensureHomeFeedReady(timeoutMs = 20000): Promise<boolean> {
        if (!this.page) throw new Error("Page not initialized");
        if (await this.isOnLoginOrChallenge()) {
            logger.warn("Instagram requires login/challenge resolution. Feed is not ready.");
            return false;
        }

        // Navigate to home if we're not already there
        const url = this.page.url();
        if (!url.startsWith("https://www.instagram.com/")) {
            await this.page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
        }

        try {
            // The redesigned feed does not always render posts as <article>;
            // accept role=article containers and post/reel permalinks too.
            await this.page.waitForSelector(
                'article, div[role="article"], a[href*="/p/"], a[href*="/reel/"]',
                { timeout: timeoutMs }
            );
            return true;
        } catch {
            const url = this.page.url();
            let title = "";
            try { title = await this.page.title(); } catch { /* ignore */ }
            try {
                await this.page.screenshot({ path: "./cookies/feed-debug.png" });
            } catch { /* ignore */ }
            logger.warn(
                `Instagram home feed did not load in time. URL: ${url}, title: "${title}" — screenshot saved to cookies/feed-debug.png`
            );
            return false;
        }
    }

    private async getPostUsernameByIndex(index: number): Promise<string | null> {
        if (!this.page) return null;
        const page = this.page;
        return await page.evaluate((i) => {
            const articleSel = `article:nth-of-type(${i})`;
            const articleEl = document.querySelector(articleSel);
            if (!articleEl) return null;

            const links = Array.from(articleEl.querySelectorAll('a[href]'));
            const hrefs = links
                .map((a) => a.getAttribute('href') || '')
                .filter(Boolean);

            for (const href of hrefs) {
                if (href.startsWith('/') && href.split('/').filter(Boolean).length === 1) {
                    return href.replace(/\//g, '');
                }
            }

            // Fallback: try header links if structure changes
            const headerLink = articleEl.querySelector('header a[href^="/"]');
            if (headerLink) {
                const href = headerLink.getAttribute('href') || '';
                if (href.startsWith('/') && href.split('/').filter(Boolean).length === 1) {
                    return href.replace(/\//g, '');
                }
            }

            return null;
        }, index);
    }

    async sendDirectMessage(username: string, message: string) {
        if (!this.page) throw new Error("Page not initialized");
        try {
            await this.sendDirectMessageWithMedia(username, message);
        } catch (error) {
            logger.error("Failed to send direct message", error);
            throw error;
        }
    }

    async sendDirectMessageWithMedia(username: string, message: string, mediaPath?: string) {
        if (!this.page) throw new Error("Page not initialized");
        try {
            await this.page.goto(`https://www.instagram.com/${username}/`, {
                waitUntil: "networkidle2",
            });
            console.log("Navigated to user profile");
            await delay(3000);

            const messageButtonSelectors = ['div[role="button"]', "button", 'a[href*="/direct/t/"]', 'div[role="button"] span', 'div[role="button"] div'];
            let messageButton: puppeteer.ElementHandle<Element> | null = null;
            for (const selector of messageButtonSelectors) {
                const elements = await this.page.$$(selector);
                for (const element of elements) {
                    const text = await element.evaluate((el: Element) => el.textContent);
                    if (text && text.trim() === "Message") {
                        messageButton = element;
                        break;
                    }
                }
                if (messageButton) break;
            }
            if (!messageButton) throw new Error("Message button not found.");
            await messageButton.click();
            await delay(2000); // Wait for message modal to open
            await this.handleNotificationPopup();

            if (mediaPath) {
                const fileInput = await this.page.$('input[type="file"]');
                if (fileInput) {
                    await fileInput.uploadFile(mediaPath);
                    await this.handleNotificationPopup();
                    await delay(2000); // wait for upload
                } else {
                    logger.warn("File input for media not found.");
                }
            }

            const messageInputSelectors = ['textarea[placeholder="Message..."]', 'div[role="textbox"]', 'div[contenteditable="true"]', 'textarea[aria-label="Message"]'];
            let messageInput: puppeteer.ElementHandle<Element> | null = null;
            for (const selector of messageInputSelectors) {
                messageInput = await this.page.$(selector);
                if (messageInput) break;
            }
            if (!messageInput) throw new Error("Message input not found.");
            await messageInput.type(message);
            await this.handleNotificationPopup();
            await delay(2000);

            const sendButtonSelectors = ['div[role="button"]', "button"];
            let sendButton: puppeteer.ElementHandle<Element> | null = null;
            for (const selector of sendButtonSelectors) {
                const elements = await this.page.$$(selector);
                for (const element of elements) {
                    const text = await element.evaluate((el: Element) => el.textContent);
                    if (text && text.trim() === "Send") {
                        sendButton = element;
                        break;
                    }
                }
                if (sendButton) break;
            }
            if (!sendButton) throw new Error("Send button not found.");
            await sendButton.click();
            await this.handleNotificationPopup();
            console.log("Message sent successfully");
        } catch (error) {
            logger.error(`Failed to send DM to ${username}`, error);
            throw error;
        }
    }

    async sendDirectMessagesFromFile(file: Buffer | string, message: string, mediaPath?: string) {
        if (!this.page) throw new Error("Page not initialized");
        logger.info(`Sending DMs from provided file content`);
        let fileContent: string;
        if (Buffer.isBuffer(file)) {
            fileContent = file.toString('utf-8');
        } else {
            fileContent = file;
        }
        const usernames = fileContent.split("\n");
        for (const username of usernames) {
            if (username.trim()) {
                await this.handleNotificationPopup();
                await this.sendDirectMessageWithMedia(username.trim(), message, mediaPath);
                await this.handleNotificationPopup();
                // add delay to avoid being flagged
                await delay(30000);
            }
        }
    }

    // Checks if a feed post is an ad/sponsored
    private async isSponsoredInArticle(index: number): Promise<{ sponsored: boolean; reason?: string }> {
        if (!this.page) return { sponsored: false };
        const page = this.page;

        const defaultMarkers = ['sponsored', 'paid partnership'];
        const defaultButtonMarkers = ['learn more', 'shop now', 'sign up', 'install now', 'get offer', 'subscribe', 'book now'];
        const markers = this.getAdMarkers(defaultMarkers);
        const buttonMarkers = this.getAdButtonMarkers(defaultButtonMarkers);

        return await page.evaluate((i, markersList, buttonMarkersList) => {
            const articleSel = `article:nth-of-type(${i})`;
            const articleEl = document.querySelector(articleSel);
            if (!articleEl) return { sponsored: false };

            // STRATEGY 1: Find elements with ad marker text.
            // Instagram often hides this in a span element containing only this word.
            const allSpans = articleEl.querySelectorAll('span');
            for (const span of allSpans) {
                const text = (span.textContent || '').toLowerCase().trim();
                const matched = markersList.find((m) => text === m || text.startsWith(m));
                if (matched) {
                    return { sponsored: true, reason: `marker:${matched}` }; // Found a direct match!
                }
            }

            // STRATEGY 2: Look for common ad call-to-action buttons.
            // This is an extremely reliable indicator of an ad.
            const allButtonsText = Array.from(articleEl.querySelectorAll('div[role="button"], a[role="button"]'))
                .map(el => (el.textContent || '').toLowerCase());

            for (const text of allButtonsText) {
                const matched = buttonMarkersList.find((marker) => text.includes(marker));
                if (matched) {
                    return { sponsored: true, reason: `button:${matched}` }; // Found an ad button!
                }
            }

            return { sponsored: false };
        }, index, markers, buttonMarkers);
    }

    private getAdMarkers(fallback: string[]): string[] {
        const raw = process.env.IG_AD_MARKERS;
        if (!raw) return fallback;
        const parsed = raw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        return parsed.length ? parsed : fallback;
    }

    private getAdButtonMarkers(fallback: string[]): string[] {
        const raw = process.env.IG_AD_BUTTON_MARKERS;
        if (!raw) return fallback;
        const parsed = raw
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        return parsed.length ? parsed : fallback;
    }

    async interactWithPosts() {
        if (!this.page) throw new Error("Page not initialized");
        const cooldown = await getIgCooldown();
        if (cooldown.until > Date.now()) {
            const minsLeft = Math.ceil((cooldown.until - Date.now()) / 60000);
            logger.warn(`IG cooldown active for ~${minsLeft} more minutes. Skipping interactions.`);
            return;
        }
        const ready = await this.ensureHomeFeedReady();
        if (!ready) {
            logger.warn("Skipping interactions because home feed is not ready.");
            return;
        }
        const profile = getIgProfile();
        const dailyLimit = profile.dailyMaxActions;
        const dailyState = await getIgDailyState();
        if (dailyLimit > 0 && dailyState.count >= dailyLimit) {
            logger.warn(`Daily action limit reached (${dailyState.count}/${dailyLimit}).`);
            return;
        }
        const startedAt = new Date();
        const summary = {
            startedAt: startedAt.toISOString(),
            finishedAt: '',
            durationMs: 0,
            postsVisited: 0,
            likes: 0,
            comments: 0,
            skippedSponsored: 0,
            errors: 0,
        };
        let postIndex = 1; // Start with the first post
        const maxPosts = profile.maxPostsPerRun; // Limit to prevent infinite scrolling
        let commentsLeft = profile.maxCommentsPerRun;
        const page = this.page;
        while (postIndex <= maxPosts) {
            // Check for exit flag
            if (typeof getShouldExitInteractions === 'function' && getShouldExitInteractions()) {
                console.log('Exit from interactions requested. Stopping loop.');
                break;
            }
            try {
                const postSelector = `article:nth-of-type(${postIndex})`;
                // Check if the post exists
                if (!(await page.$(postSelector))) {
                    console.log("No more posts found. Ending iteration...");
                    break;
                }

                // Skip sponsored/ads
                const sponsoredCheck = await this.isSponsoredInArticle(postIndex);
                if (sponsoredCheck.sponsored) {
                    const reason = sponsoredCheck.reason ? ` (${sponsoredCheck.reason})` : "";
                    console.log(`Post ${postIndex} appears sponsored. Skipping interactions.${reason}`);
                    summary.skippedSponsored++;
                    await delay(1000);
                    await page.evaluate(() => {
                        window.scrollBy(0, window.innerHeight);
                    });
                    postIndex++;
                    continue;
                }

                const likeIconSelector = `${postSelector} svg[aria-label="Like"], ${postSelector} svg[aria-label="Unlike"]`;
                const likeIcon = await page.$(likeIconSelector);
                let ariaLabel: string | null = null;
                if (likeIcon) {
                    ariaLabel = await likeIcon.evaluate((el: Element) => {
                        const self = el.getAttribute("aria-label");
                        if (self) return self;
                        const button = el.closest("button");
                        return button ? button.getAttribute("aria-label") : null;
                    });
                }
                if (ariaLabel === "Like" && likeIcon) {
                    console.log(`Liking post ${postIndex}...`);
                    // The icon can sit outside the viewport after scrolling —
                    // clicking it there throws "Node is either not clickable".
                    await likeIcon.evaluate((el: Element) => el.scrollIntoView({ block: "center" }));
                    await delay(500);
                    await likeIcon.click();
                    await page.keyboard.press("Enter");
                    console.log(`Post ${postIndex} liked.`);
                    if (dailyLimit > 0) {
                        await incrementIgDailyCount(1);
                    }
                    summary.likes++;
                } else if (ariaLabel === "Unlike") {
                    console.log(`Post ${postIndex} is already liked.`);
                } else {
                    console.log(`Like button not found for post ${postIndex}.`);
                }

                const username = await this.getPostUsernameByIndex(postIndex);
                if (username) {
                    console.log(`Post ${postIndex} by @${username}`);
                } else {
                    console.log(`Post ${postIndex} username not found.`);
                }
                // Extract and log the post caption
                const captionSelector = `${postSelector} div.x9f619 span._ap3a div span._ap3a`;
                const captionElement = await page.$(captionSelector);
                let caption = "";
                if (captionElement) {
                    caption = await captionElement.evaluate((el) => (el as HTMLElement).innerText);
                    console.log(`Caption for post ${postIndex}: ${caption}`);
                } else {
                    console.log(`No caption found for post ${postIndex}.`);
                }
                // Check if there is a '...more' link to expand the caption
                const moreLinkSelector = `${postSelector} div.x9f619 span._ap3a span div span.x1lliihq`;
                const moreLink = await page.$(moreLinkSelector);
                if (moreLink && captionElement) {
                    console.log(`Expanding caption for post ${postIndex}...`);
                    await moreLink.click();
                    const expandedCaption = await captionElement.evaluate((el) => (el as HTMLElement).innerText);
                    console.log(
                        `Expanded Caption for post ${postIndex}: ${expandedCaption}`
                    );
                    caption = expandedCaption;
                }
                // Comment on the post (capped per run by profile.maxCommentsPerRun)
                if (commentsLeft > 0) {
                    console.log(`Commenting on post ${postIndex}...`);
                    const prompt = `human-like Instagram comment based on to the following post: "${caption}". make sure the reply\n            Matchs the tone of the caption (casual, funny, serious, or sarcastic).\n            Sound organic—avoid robotic phrasing, overly perfect grammar, or anything that feels AI-generated.\n            Use relatable language, including light slang, emojis (if appropriate), and subtle imperfections like minor typos or abbreviations (e.g., 'lol' or 'omg').\n            If the caption is humorous or sarcastic, play along without overexplaining the joke.\n            If the post is serious (e.g., personal struggles, activism), respond with empathy and depth.\n            Avoid generic praise ('Great post!'); instead, react specifically to the content (e.g., 'The way you called out pineapple pizza haters 😂👏').\n            *Keep it concise (1-2 sentences max) and compliant with Instagram's guidelines (no spam, harassment, etc.).*`;
                    const schema = getInstagramCommentSchema();
                    const result = await runAgent(schema, prompt);
                    const comment = (Array.isArray(result) ? result[0]?.comment ?? "" : "") as string;
                    const filterCfg = getCommentFilterConfig();
                    if (!comment) {
                        console.log(`No comment generated for post ${postIndex} (AI unavailable?). Skipping comment.`);
                    } else if (shouldSkipComment(comment, filterCfg)) {
                        console.log(`Comment blocked by filters for post ${postIndex}.`);
                    } else {
                        // Inline composer first (legacy feed markup)...
                        const commentBoxSelector = `${postSelector} textarea[aria-label*="comment"], ${postSelector} textarea[placeholder*="comment"], ${postSelector} textarea`;
                        let box = await page.$(commentBoxSelector);
                        let usedModal = false;
                        if (!box) {
                            // ...otherwise click the article's Comment icon — the
                            // redesign opens the post dialog which holds the composer.
                            const clicked = await page.evaluate((sel) => {
                                const article = document.querySelector(sel);
                                const svg = article && article.querySelector('svg[aria-label="Comment"]');
                                const btn = svg && (svg.closest('div[role="button"], button, a') as HTMLElement | null);
                                if (btn) { btn.click(); return true; }
                                return false;
                            }, postSelector);
                            if (clicked) {
                                usedModal = true;
                                await delay(2000);
                                box = await page.$('div[role="dialog"] textarea, div[role="dialog"] div[contenteditable="true"], textarea[aria-label*="omment"], div[contenteditable="true"][role="textbox"]');
                            }
                        }
                        if (box) {
                            await box.click();
                            await delay(400);
                            await page.keyboard.type(comment, { delay: 30 });
                            await delay(800);
                            const posted = await page.evaluate(() => {
                                const scope = document.querySelector('div[role="dialog"]') || document;
                                const labels = ['post', 'opublikuj', 'publish'];
                                const btns = Array.from(scope.querySelectorAll('div[role="button"], button, [type="submit"]'));
                                const target = btns.find((b) => {
                                    const t = (b.textContent || '').trim().toLowerCase();
                                    return labels.includes(t) && !b.hasAttribute('disabled') && (b as HTMLElement).getAttribute('aria-disabled') !== 'true';
                                }) as HTMLElement | undefined;
                                if (target) { target.click(); return true; }
                                return false;
                            });
                            if (!posted) {
                                await page.keyboard.press('Enter');
                            }
                            console.log(`Comment posted on post ${postIndex}: "${comment}"`);
                            if (dailyLimit > 0) {
                                await incrementIgDailyCount(1);
                            }
                            summary.comments++;
                            commentsLeft--;
                            await delay(2500);
                        } else {
                            console.log("Comment box not found.");
                        }
                        if (usedModal) {
                            // Close the post dialog and let the feed settle.
                            await page.keyboard.press('Escape');
                            await delay(1500);
                        }
                    }
                }
                summary.postsVisited++;
                if (dailyLimit > 0) {
                    const updated = await getIgDailyState();
                    if (updated.count >= dailyLimit) {
                        logger.warn(`Daily action limit reached (${updated.count}/${dailyLimit}). Stopping.`);
                        break;
                    }
                }
                // Wait before moving to the next post
                const waitTime =
                    Math.floor(Math.random() * (profile.maxDelayMs - profile.minDelayMs + 1)) +
                    profile.minDelayMs;
                console.log(
                    `Waiting ${waitTime / 1000} seconds before moving to the next post...`
                );
                await delay(waitTime);
                // Extra wait to ensure all actions are complete before scrolling
                await delay(1000);
                // Scroll to the next post
                await page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight);
                });
                postIndex++;
            } catch (error) {
                console.error(`Error interacting with post ${postIndex}:`, error);
                summary.errors++;
                // One flaky post shouldn't end the whole run, but repeated
                // failures usually mean the page is broken — stop then.
                if (summary.errors >= 3) {
                    console.log("Too many post errors; ending iteration.");
                    break;
                }
                await page.evaluate(() => {
                    window.scrollBy(0, window.innerHeight);
                });
                postIndex++;
            }
        }
        const finishedAt = new Date();
        summary.finishedAt = finishedAt.toISOString();
        summary.durationMs = finishedAt.getTime() - startedAt.getTime();
        setLastRunSummary(summary);
        logger.info(`IG run summary: ${JSON.stringify(summary)}`);
    }

    /**
     * Visit a specific profile and like up to `maxLikes` of its posts while
     * leaving at most `maxComments` AI-generated comments. Unlike
     * interactWithPosts (home feed only), this targets one account's posts and
     * enforces separate like/comment caps.
     */
    async interactWithUserPosts(
        targetUsername: string,
        maxLikes: number = 5,
        maxComments: number = 1,
        maxCommentWords?: number
    ) {
        if (!this.page) throw new Error("Page not initialized");
        if (await this.isOnLoginOrChallenge()) {
            logger.warn("Instagram requires login/challenge resolution. Aborting.");
            throw new Error("Not authenticated (login/challenge required).");
        }
        const page = this.page;
        const profile = getIgProfile();
        const startedAt = new Date();
        const summary = {
            startedAt: startedAt.toISOString(),
            finishedAt: '',
            durationMs: 0,
            target: targetUsername,
            postsVisited: 0,
            likes: 0,
            comments: 0,
            skippedSponsored: 0,
            errors: 0,
        };

        logger.info(`Visiting profile @${targetUsername} (target: ${maxLikes} likes, ${maxComments} comment(s))`);
        await page.goto(`https://www.instagram.com/${targetUsername}/`, { waitUntil: "networkidle2" });
        await this.dismissCookieConsent();

        // Collect post permalinks from the profile grid.
        try {
            await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 20000 });
        } catch {
            logger.warn(`No posts found on @${targetUsername} (private account or empty grid?).`);
            const finishedAtEarly = new Date();
            summary.finishedAt = finishedAtEarly.toISOString();
            summary.durationMs = finishedAtEarly.getTime() - startedAt.getTime();
            setLastRunSummary(summary);
            return summary;
        }
        const links: string[] = await page.evaluate(() => {
            const set = new Set<string>();
            document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]').forEach((a) => {
                const href = a.getAttribute('href');
                if (href) set.add(href.split('?')[0]);
            });
            return Array.from(set);
        });
        const targetCount = Math.max(maxLikes, maxComments);
        const postLinks = links.slice(0, targetCount);
        logger.info(`Found ${links.length} posts on @${targetUsername}; will process ${postLinks.length}.`);

        let likesLeft = maxLikes;
        let commentsLeft = maxComments;

        for (const link of postLinks) {
            if (likesLeft <= 0 && commentsLeft <= 0) break;
            try {
                await page.goto(`https://www.instagram.com${link}`, { waitUntil: "networkidle2" });
                await delay(1500);
                summary.postsVisited++;

                // Like: find the action bar (section containing both Like and Comment) and click Like.
                if (likesLeft > 0) {
                    const likeResult = await page.evaluate(() => {
                        const sections = Array.from(document.querySelectorAll('section'));
                        for (const sec of sections) {
                            const like = sec.querySelector('svg[aria-label="Like"]');
                            const hasComment = sec.querySelector('svg[aria-label="Comment"]');
                            if (like && hasComment) {
                                const btn = like.closest('div[role="button"], button, a') as HTMLElement | null;
                                if (btn) { btn.click(); return 'liked'; }
                            }
                            if (!like && sec.querySelector('svg[aria-label="Unlike"]') && hasComment) {
                                return 'already';
                            }
                        }
                        return 'notfound';
                    });
                    if (likeResult === 'liked') {
                        summary.likes++;
                        likesLeft--;
                        logger.info(`Liked ${link} (${summary.likes}/${maxLikes}).`);
                    } else if (likeResult === 'already') {
                        logger.info(`${link} already liked, skipping like.`);
                    } else {
                        logger.warn(`Like button not found on ${link}.`);
                    }
                    await delay(1200);
                }

                // Comment: only while we still have comment budget.
                if (commentsLeft > 0) {
                    const caption: string = await page.evaluate(() => {
                        const h1 = document.querySelector('h1');
                        if (h1 && (h1 as HTMLElement).innerText) return (h1 as HTMLElement).innerText;
                        const meta = document.querySelector('meta[property="og:description"]');
                        return meta ? (meta.getAttribute('content') || '') : '';
                    });
                    const lengthRule = maxCommentWords && maxCommentWords > 0
                        ? `STRICT LIMIT: ${maxCommentWords} words maximum`
                        : `Keep it concise (1 short sentence)`;
                    const prompt = `human-like Instagram comment based on the following post: "${caption}". ${lengthRule}, warm and specific, sound organic (light slang/emoji ok), avoid generic praise.`;
                    const schema = getInstagramCommentSchema();
                    // The AI free tier occasionally returns empty; retry once.
                    let comment = "";
                    for (let attempt = 0; attempt < 2 && !comment; attempt++) {
                        if (attempt > 0) await delay(3000);
                        const result = await runAgent(schema, prompt);
                        comment = (Array.isArray(result) ? result[0]?.comment : "") as string;
                    }
                    const filterCfg = getCommentFilterConfig();
                    if (!comment) {
                        logger.warn(`No comment generated for ${link} (AI unavailable?). Skipping comment.`);
                    } else if (shouldSkipComment(comment, filterCfg)) {
                        logger.info(`Comment blocked by filters for ${link}.`);
                    } else {
                        // On the post page the comment composer is not mounted until
                        // the Comment icon is clicked; do that first to reveal it.
                        await page.evaluate(() => {
                            const svg = document.querySelector('svg[aria-label="Comment"]');
                            const btn = svg && (svg.closest('div[role="button"], button, a') as HTMLElement | null);
                            if (btn) btn.click();
                        });
                        await delay(1500);
                        // Composer may be a <textarea> or a contenteditable div.
                        const composerSel = 'textarea[aria-label*="omment"], textarea[placeholder*="omment"], textarea, div[contenteditable="true"][role="textbox"], div[aria-label*="omment"][contenteditable="true"]';
                        const box = await page.$(composerSel);
                        if (box) {
                            await box.click();
                            await delay(400);
                            await page.keyboard.type(comment, { delay: 30 });
                            await delay(800);
                            const posted = await page.evaluate(() => {
                                const labels = ['post', 'opublikuj', 'publish'];
                                const btns = Array.from(document.querySelectorAll('div[role="button"], button, [type="submit"]'));
                                const target = btns.find((b) => {
                                    const t = (b.textContent || '').trim().toLowerCase();
                                    return labels.includes(t) && !b.hasAttribute('disabled') && (b as HTMLElement).getAttribute('aria-disabled') !== 'true';
                                }) as HTMLElement | undefined;
                                if (target) { target.click(); return true; }
                                return false;
                            });
                            // Fallback: submit with Enter if no Post button was found.
                            let confirmed = posted;
                            if (!confirmed) {
                                await page.keyboard.press('Enter');
                                confirmed = true;
                            }
                            if (confirmed) {
                                summary.comments++;
                                commentsLeft--;
                                logger.info(`Commented on ${link}: "${comment}"`);
                                await delay(2500);
                            }
                        } else {
                            // Capture what the post page actually renders so the
                            // missing-composer issue is diagnosable from the logs.
                            const diag = await page.evaluate(() => ({
                                url: location.href,
                                textareas: document.querySelectorAll('textarea').length,
                                editables: document.querySelectorAll('div[contenteditable="true"]').length,
                                forms: document.querySelectorAll('form').length,
                                commentsOff: !!Array.from(document.querySelectorAll('span, div'))
                                    .find((el) => /comments (on this post )?have been limited|commenting .* (off|disabled)/i.test(el.textContent || '')),
                            }));
                            try { await page.screenshot({ path: "./cookies/comment-debug.png" }); } catch { /* ignore */ }
                            logger.warn(`Comment box not found on ${link}. Diag: ${JSON.stringify(diag)} — screenshot saved to cookies/comment-debug.png`);
                        }
                    }
                }

                const waitTime = Math.floor(Math.random() * (profile.maxDelayMs - profile.minDelayMs + 1)) + profile.minDelayMs;
                await delay(waitTime);
            } catch (error) {
                logger.error(`Error interacting with ${link}:`, error);
                summary.errors++;
            }
        }

        const finishedAt = new Date();
        summary.finishedAt = finishedAt.toISOString();
        summary.durationMs = finishedAt.getTime() - startedAt.getTime();
        setLastRunSummary(summary);
        logger.info(`Targeted IG run summary: ${JSON.stringify(summary)}`);
        return summary;
    }

    async scrapeFollowers(targetAccount: string, maxFollowers: number) {
        if (!this.page) throw new Error("Page not initialized");
        const page = this.page;
        try {
            // Navigate to the target account's followers page
            await page.goto(`https://www.instagram.com/${targetAccount}/followers/`, {
                waitUntil: "networkidle2",
            });
            console.log(`Navigated to ${targetAccount}'s followers page`);

            // Wait for the followers modal to load (try robustly)
            try {
                await page.waitForSelector('div a[role="link"] span[title]');
            } catch {
                // fallback: wait for dialog
                await page.waitForSelector('div[role="dialog"]');
            }
            console.log("Followers modal loaded");

            const followers: string[] = [];
            let previousHeight = 0;
            let currentHeight = 0;
            maxFollowers = maxFollowers + 4;
            // Scroll and collect followers until we reach the desired amount or can't scroll anymore
            console.log(maxFollowers);
            while (followers.length < maxFollowers) {
                // Get all follower links in the current view
                const newFollowers = await page.evaluate(() => {
                    const followerElements =
                        document.querySelectorAll('div a[role="link"]');
                    return Array.from(followerElements)
                        .map((element) => element.getAttribute("href"))
                        .filter(
                            (href): href is string => href !== null && href.startsWith("/")
                        )
                        .map((href) => href.substring(1)); // Remove leading slash
                });

                // Add new unique followers to our list
                for (const follower of newFollowers) {
                    if (!followers.includes(follower) && followers.length < maxFollowers) {
                        followers.push(follower);
                        console.log(`Found follower: ${follower}`);
                    }
                }

                // Scroll the followers modal
                await page.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    if (dialog) {
                        dialog.scrollTop = dialog.scrollHeight;
                    }
                });

                // Wait for potential new content to load
                await delay(1000);

                // Check if we've reached the bottom
                currentHeight = await page.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    return dialog ? dialog.scrollHeight : 0;
                });

                if (currentHeight === previousHeight) {
                    console.log("Reached the end of followers list");
                    break;
                }

                previousHeight = currentHeight;
            }

            console.log(`Successfully scraped ${followers.length - 4} followers`);
            return followers.slice(4, maxFollowers);
        } catch (error) {
            console.error(`Error scraping followers for ${targetAccount}:`, error);
            throw error;
        }
    }

    public async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }
}

export async function scrapeFollowersHandler(targetAccount: string, maxFollowers: number) {
    const client = new IgClient();
    await client.init();
    const followers = await client.scrapeFollowers(targetAccount, maxFollowers);
    await client.close();
    return followers;
}
