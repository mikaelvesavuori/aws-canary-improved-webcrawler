const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');
const BrokenLinkCheckerReport = require('BrokenLinkCheckerReport');
const SyntheticsLink = require('SyntheticsLink');

/**
 * Insert URLs
 */
const URL_LIST = ['https://www.mydomain.com/'];

/**
 * Specify if the crawler should only accept request within a single domain
 */
const MUST_INCLUDE_DOMAIN = true;
const DOMAIN = 'mydomain.com';

/**
 * Maximum number of links that should be followed
 */
const MAX_NUM_LINKS_TO_FOLLOW = 750;

/**
 * Close and Re-launch browser after checking these many links.
 * This clears up /tmp disk storage occupied by Chromium and launches a new browser for next set of links.
 */
const NUM_LINKS_TO_RELAUNCH_BROWSER = 5;

/**
 * Puppeteer/crawler timeout in milliseconds (per page)
 */
const TIMEOUT = 15000;

/**
 * Network wait condition. Should be one of "networkidle0", "networkidle2", or "domcontentloaded"
 */
const NETWORK_WAIT_CONDITION = 'domcontentloaded';

/**
 * Captures source page annotated screenshot for each link followed on a page
 */
const CAPTURE_SOURCE_PAGE_SCREENSHOT = false;

/**
 * Captures destination page screenshot after loading a link successfully
 */
const CAPTURE_DESTINATION_PAGE_SCREENSHOT_ON_SUCCESS = false;

/**
 * Captures destination page screenshot for broken links only.
 */
const CAPTURE_DESTINATION_PAGE_SCREENSHOT_ON_FAILURE = false;

/**
 * Annotation border color
 */
const ANNOTATION_BORDER_COLOR = '3px solid #e67e22';

/**
 * Errors
 */
const ERROR_SCREENSHOT = 'Unable to capture screenshot.';
const ERROR_BLANK_PAGE = 'Unable to open a blank page ';
const ERROR_LINK_TO_BROKEN_REPORT = 'Unable to add link to broken link checker report.';

/**
 * @description async function used to grab urls from page. fetch hrefs from DOM
 *
 * @param {*} page
 * @param {*} sourceUrl
 * @param {*} exploredUrls
 * @returns
 */
const grabLinks = async function (page, sourceUrl, exploredUrls) {
  let grabbedLinks = [];

  const jsHandle = await page.evaluateHandle(() => {
    return document.getElementsByTagName('a');
  });

  const numberOfLinks = await page.evaluate((e) => e.length, jsHandle);

  for (let i = 0; i < numberOfLinks; i++) {
    let element = await page.evaluate(
      (jsHandle, i, CAPTURE_SOURCE_PAGE_SCREENSHOT, exploredUrls) => {
        let element = jsHandle[i];
        let url = String(element.href).trim();

        // Condition for grabbing a link
        if (
          url != null &&
          url.length > 0 &&
          !exploredUrls.includes(url) &&
          (url.startsWith('http') || url.startsWith('https'))
        ) {
          let text = element.text ? element.text.trim() : '';
          let originalBorderProp = element.style.border;

          // Annotate this anchor element for source page screenshot.
          if (CAPTURE_SOURCE_PAGE_SCREENSHOT) {
            element.style.border = ANNOTATION_BORDER_COLOR;
            element.scrollIntoViewIfNeeded();
          }
          return { text, url, originalBorderProp };
        }
      },
      jsHandle,
      i,
      CAPTURE_SOURCE_PAGE_SCREENSHOT,
      exploredUrls
    );

    if (element) {
      let url = element.url;
      let originalBorderProp = element.originalBorderProp;
      exploredUrls.push(url);

      let sourcePageScreenshotResult;
      if (CAPTURE_SOURCE_PAGE_SCREENSHOT) {
        sourcePageScreenshotResult = await takeScreenshot(getFileName(url), 'sourcePage');

        // Reset css to original
        await page.evaluate(
          (jsHandle, i, originalBorderProp) => {
            let element = jsHandle[i];
            element.style.border = originalBorderProp;
          },
          jsHandle,
          i,
          originalBorderProp
        );
      }

      let link = new SyntheticsLink(url).withParentUrl(sourceUrl).withText(element.text);
      link.addScreenshotResult(sourcePageScreenshotResult);
      grabbedLinks.push(link);

      if (exploredUrls.length >= MAX_NUM_LINKS_TO_FOLLOW) break;
    }
  }
  return grabbedLinks;
};

/**
 * @description Take synthetics screenshot
 *
 * @param {*} fileName
 * @param {*} suffix
 * @returns
 */
const takeScreenshot = async function (fileName, suffix) {
  try {
    return await synthetics.takeScreenshot(fileName, suffix);
  } catch (error) {
    //synthetics.addExecutionError(ERROR_SCREENSHOT, error);
  }
};

/**
 * @description Get the fileName for the screenshot based on the URI
 *
 * @param {*} url
 * @param {*} defaultName
 * @returns
 */
const getFileName = function (url, defaultName = 'loaded') {
  if (!url) return defaultName;

  const uri = new URL(url);
  const pathname = uri.pathname.replace(/\/$/, ''); //remove trailing '/'
  const fileName = !!pathname ? pathname.split('/').pop() : 'index';

  // Remove characters which can't be used in S3
  return fileName.replace(/[^a-zA-Z0-9-_.!*'()]+/g, '');
};

/**
 * @description Broken link checker blueprint just uses one page to test availability of several urls
 * Reset the page in-between to force a network event in case of a single page app
 *
 * @param {*} page
 */
const resetPage = async function (page) {
  try {
    await page.goto('about:blank', { waitUntil: ['load', NETWORK_WAIT_CONDITION], TIMEOUT });
  } catch (error) {
    //synthetics.addExecutionError(ERROR_BLANK_PAGE, error);
  }
};

/**
 * @description Run the web crawler
 */
const webCrawlerController = async function () {
  // Setup
  const exploredUrls = URL_LIST.slice();
  let synLinks = [];
  let count = 0;
  let canaryError = null;
  let brokenLinkError = null;
  let brokenLinkCheckerReport = new BrokenLinkCheckerReport();
  let page = await synthetics.getPage();

  exploredUrls.forEach((url) => {
    synLinks.push(new SyntheticsLink(url));
  });

  while (synLinks.length > 0) {
    let link = synLinks.shift();
    let nav_url = link.getUrl();
    let fileName = getFileName(nav_url);
    let response = null;

    count++;

    /**
     * Reset page or close/launch for refresh
     */
    if (count % NUM_LINKS_TO_RELAUNCH_BROWSER == 0 && count != MAX_NUM_LINKS_TO_FOLLOW) {
      await synthetics.close();
      await synthetics.launch();
      page = await synthetics.getPage();
    } else if (count != 1) {
      await resetPage(page);
    }

    /**
     * Load URL and start requesting
     * Only accept "documents" or pages
     */
    try {
      await page.setRequestInterception(true);

      page.removeAllListeners('request');
      page.on('request', (request) => {
        if (request.resourceType() === 'document') {
          if (MUST_INCLUDE_DOMAIN && request.url().includes(DOMAIN)) request.continue();
          else request.continue();
        } else {
          request.abort();
        }
      });

      response = await page.goto(nav_url, {
        waitUntil: ['load', NETWORK_WAIT_CONDITION],
        TIMEOUT
      });
      if (!response) {
        brokenLinkError = 'Failed to receive network response for url: ' + nav_url;
        link = link.withFailureReason('Received null or undefined response');
      }
    } catch (error) {
      brokenLinkError = 'Failed to load url: ' + nav_url + '. ' + error;
      link = link.withFailureReason(error.toString());
    }

    /**
     * If valid non-error status, take screenshot if toggled to do so
     */
    if (response && response.status() && response.status() < 400) {
      link = link.withStatusCode(response.status()).withStatusText(response.statusText());
      if (CAPTURE_DESTINATION_PAGE_SCREENSHOT_ON_SUCCESS) {
        let screenshotResult = await takeScreenshot(fileName, 'succeeded');
        link.addScreenshotResult(screenshotResult);
      }
    } else if (response) {
      // Received 400s or 500s
      const statusString = 'Status code: ' + response.status() + ' ' + response.statusText();
      brokenLinkError = 'Failed to load url: ' + nav_url + '. ' + statusString;

      link = link
        .withStatusCode(response.status())
        .withStatusText(response.statusText())
        .withFailureReason(statusString);

      if (CAPTURE_DESTINATION_PAGE_SCREENSHOT_ON_FAILURE) {
        let screenshotResult = await takeScreenshot(fileName, 'failed');
        link.addScreenshotResult(screenshotResult);
      }
    }

    /**
     * Adds this link to broken link checker report
     */
    try {
      brokenLinkCheckerReport.addLink(link);
    } catch (error) {
      //synthetics.addExecutionError(ERROR_LINK_TO_BROKEN_REPORT, error);
    }

    /**
     * If current link was successfully loaded, grab more hyperlinks from this page.
     */
    if (
      response &&
      response.status() &&
      response.status() < 400 &&
      exploredUrls.length < MAX_NUM_LINKS_TO_FOLLOW
    ) {
      try {
        let moreLinks = await grabLinks(page, nav_url, exploredUrls);
        if (moreLinks && moreLinks.length > 0) {
          synLinks = synLinks.concat(moreLinks);
        }
      } catch (error) {
        //canaryError = 'Unable to grab urls on page: ' + nav_url + '. ' + error;
      }
    }
  }

  /**
   * Add report
   */
  try {
    synthetics.addReport(brokenLinkCheckerReport);
  } catch (error) {
    //synthetics.addExecutionError(ERROR_LINK_TO_BROKEN_REPORT, error);
  }

  log.info('Total links checked: ' + brokenLinkCheckerReport.getTotalLinksChecked());

  /**
   * Fail canary if 1 or more broken links found
   */
  if (brokenLinkCheckerReport.getTotalBrokenLinks() != 0) {
    brokenLinkError =
      brokenLinkCheckerReport.getTotalBrokenLinks() +
      ' broken link(s) detected. ' +
      brokenLinkError;
    canaryError = canaryError ? brokenLinkError + ' ' + canaryError : brokenLinkError;
  }

  if (canaryError) throw canaryError;
};

/**
 * @description Handler for web crawler
 */
exports.handler = async () => {
  return await webCrawlerController();
};
