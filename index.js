import * as Sentry from "@sentry/node";
import cacache from "cacache";
import colors from "colors";
import dotenv from "dotenv";
import express from "express";
import equal from "fast-deep-equal";
import got from "got";
import hasha from "hasha";
import indentString from "indent-string";
import nunjucks from "nunjucks";
import pRetry from "p-retry";
import puppeteer from "puppeteer";
import stream from "stream";
import Twitter from "twitter-lite";
import util from "util";
import winston from "winston";

const CACHE_PATH = "data/cache";
const CHECK_INTERVAL = 900000;

const pipeline = util.promisify(stream.pipeline);

dotenv.config({
  silent: true,
});

nunjucks.configure({
  noCache: true,
});

Sentry.init({
  enabled: process.env.NODE_ENV === "production",
  dsn: process.env.SENTRY_DNS,
  tracesSampleRate: 1.0,
});

const createFormat = (colorize) => {
  const h = (input, color) => (colorize ? color(input) : input);

  const replacer = (key, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }

    if (value instanceof Buffer) {
      return value.toString("base64");
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    return value;
  };

  const formats = [
    winston.format.timestamp({ format: "mediumTime" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(
      ({ label, level, message, stack, timestamp, ...rest }) => {
        let result = `[${timestamp}] `;

        if (label) {
          result += `${h(label, colors.bold)} `;
        }

        result += `${level}: ${message}`;

        if (stack) {
          result += `\n${indentString(h(stack, colors.gray), 4)}`;
        }

        if (Object.keys(rest).length > 0) {
          result += `\n${indentString(
            h(JSON.stringify(rest, replacer, 4), colors.gray),
            4
          )}`;
        }

        return result;
      }
    ),
  ];

  if (colorize) {
    formats.unshift(winston.format.colorize());
  }

  return winston.format.combine(...formats);
};

const logger = winston.createLogger({
  handleExceptions: true,
  transports: [
    new winston.transports.Console({
      format: createFormat(true),
    }),
    new winston.transports.File({
      filename: `data/logs/${Date.now()}.log`,
      format: createFormat(false),
    }),
  ],
});

const newTwitterClient = (subdomain) =>
  new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
    subdomain,
  });

const cacheMedia = async (url) => {
  const key = hasha(url);

  try {
    await cacache.get(CACHE_PATH, `media:${key}`);
  } catch {
    await pipeline(
      got.stream(url),
      cacache.put.stream(CACHE_PATH, `media:${key}`)
    );
  }

  return `/media/${key}`;
};

const getState = async () => {
  let result = {
    date: new Date(0),
    pages: [],
  };

  try {
    result = JSON.parse(
      (await cacache.get(CACHE_PATH, "store:state")).data.toString()
    );

    result.date = new Date(result.date);
  } catch {}

  return result;
};

const servePage = async (context, handler) => {
  const app = express();

  app.use(express.static("public"));

  app.get("/media/:key", async (request, response, next) => {
    try {
      await pipeline(
        cacache.get.stream(CACHE_PATH, `media:${request.params.key}`),
        response
      );
    } catch (error) {
      if (response.headersSent) {
        return next(error);
      }

      response.sendStatus(404);
    }
  });

  app.get("/", (request, response) => {
    const body = nunjucks.render("public/index.njk", context);

    response.type("text/html");
    response.send(body);
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const url = `http://localhost:${server.address().port}`;

      try {
        resolve(await handler(url));
      } catch (error) {
        reject(error);
      }

      server.close();
    });
  });
};

const capturePage = (state, viewport) => {
  return servePage(state, async (url) => {
    let browser;

    try {
      browser = await puppeteer.launch({
        args: ["--disable-setuid-sandbox", "--no-sandbox"],
      });

      const page = await browser.newPage();

      await page.setViewport({ height: 0, ...viewport });
      await page.goto(url, { waitUntil: "networkidle0" });

      return await page.screenshot({ fullPage: true });
    } finally {
      await browser.close();
    }
  });
};

const api = got.extend({
  prefixUrl: "https://www.coregames.com/api/",
  responseType: "json",
});

const twitter = {
  api: newTwitterClient("api"),
  upload: newTwitterClient("upload"),
};

let timeoutHandle;

const checkStoreUpdate = async () => {
  await cacache.verify(CACHE_PATH);

  logger.info("Checking for store updates...");

  const state = {
    date: new Date(),
    pages: [],
  };

  logger.debug("Fetching store pages...");

  const {
    body: { pageSummaries },
  } = await api.get("store/pages");

  for (const { pageId } of pageSummaries) {
    logger.debug("Fetching store page %s...", pageId);

    const {
      body: {
        page: { bundles, pageName, pageStyle },
      },
    } = await api.get(`store/pages/${pageId}`);

    if (pageStyle === "Token") {
      continue;
    }

    const page = {
      id: pageId,
      name: pageName,
      style: pageStyle,
      items: await Promise.all(
        bundles.map(async (bundle) => {
          const { priceInVirtualTokens } = bundle;

          const price = {
            currency: priceInVirtualTokens.type,
            amount: priceInVirtualTokens.amount,
          };

          if (price.currency === "Unknown") {
            price.currency = bundle.currency;
            price.amount = bundle.price;
          }

          return {
            id: bundle.id,
            name: bundle.name,
            imageUrl: await cacheMedia(bundle.imageUrl),
            price,
          };
        })
      ),
    };

    state.pages.push(page);
  }

  logger.debug("Comparing store states...");

  const oldState = await getState();
  const sameState = equal(state.pages, oldState.pages);

  logger.info(
    sameState
      ? "No store changes, skipping..."
      : "Store changes detected, generating image..."
  );

  if (sameState) {
    return;
  }

  await pRetry(
    async () => {
      const buffer = await capturePage(state, {
        width: 1054,
      });

      logger.debug("Uploading image to Twitter...");

      const response = await twitter.upload.post("media/upload", {
        media_data: buffer.toString("base64"),
      });

      logger.debug("Sending new Twitter status...");

      const dateString = state.date.toLocaleString("en-US", {
        dateStyle: "long",
        timeStyle: "short",
      });

      await twitter.api.post("statuses/update", {
        media_ids: response.media_id_string,
        status: `#CoreGames Item Shop Update (${dateString})`,
      });
    },
    {
      onFailedAttempt() {
        logger.error("Failed to complete the store update, retrying...");
      },
    }
  );

  logger.debug("Saving store state...");

  await cacache.put(CACHE_PATH, "store:state", JSON.stringify(state));

  logger.info("Store update check done");
};

const scheduleStoreUpdate = async () => {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  try {
    await checkStoreUpdate();
  } catch (error) {
    Sentry.captureException(error);

    logger.error(
      "An error occured while checking for the store updates:",
      error
    );
  }

  timeoutHandle = setTimeout(scheduleStoreUpdate, CHECK_INTERVAL);
};

scheduleStoreUpdate();
