import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as cheerio from "cheerio";
import { RequestInfo, RequestInit } from "node-fetch";

const fetch = (url: RequestInfo, init?: RequestInit) =>
  import("node-fetch").then(({ default: fetch }) => fetch(url, init));

admin.initializeApp();
const db = admin.firestore();
const batch = db.batch();
const productsColl = db.collection("Products");
const compare = (searchText: string, itemName: string) => {
  if (searchText.length < 2 || itemName.length < 2) {
    if (itemName.includes(searchText)) {
      return 1;
    }
    return 0;
  }
  let searchTextEveryTwo = new Map();
  for (let i = 0; i < searchText.length - 1; i++) {
    let everyTwo = searchText.substring(i, 2);
    let count = searchTextEveryTwo.has(everyTwo)
      ? searchTextEveryTwo.get(everyTwo) + 1
      : 1;
    searchTextEveryTwo.set(everyTwo, count);
  }
  let matches = 0;
  for (let i = 0; i < itemName.length - 1; i++) {
    let everyTwo = itemName.substring(i, 2);
    let count = searchTextEveryTwo.has(everyTwo)
      ? searchTextEveryTwo.get(everyTwo)
      : 0;
    if (count > 0) {
      searchTextEveryTwo.set(everyTwo, count - 1);
      matches += 2;
    }
  }
  return matches / (searchText.length + itemName.length - 2);
};
const filter = (txt: string, originalArray: any[]) => {
  let allItems: any[] = [];
  let comparisonValArr = [];
  originalArray.forEach((element) => {
    let comparisonVal = compare(txt.toLowerCase(), element.name.toLowerCase());
    if (comparisonVal > 0.3) {
      comparisonValArr.push(comparisonVal);
      allItems.push({ ...element, coefficient: comparisonVal });
    }
  });
  console.error(allItems);
  return allItems.sort((a, b) => b.coefficient - a.coefficient);
};
const searchAlg = (txt: string, originalArray: any[]) => {
  if (txt.trim() === "") {
    return originalArray;
  }
  let filteredItems = filter(txt.trim(), originalArray);
  return filteredItems;
};
exports.runScraper = functions
  .runWith({ timeoutSeconds: 540 })
  .pubsub.schedule("every 60 minutes")
  .onRun(async (context) => {
    scraperMain();
    return null;
  });
exports.scraperTester = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onCall(async (data, context) => {
    scraperMain();
    return null;
  });
exports.putProducts = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onCall((data, context) => {
    let products: any[] = data.products;
    products.forEach((product) => {
      const docRef = db.collection("Products").doc();
      batch.set(docRef, product);
    });
    batch.commit();
  });
exports.putDailyProducts = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onCall((data, context) => {
    const today = new Date();
    let products: any[] = data.products;
    products.forEach((product) => {
      const docRef = db
        .collection("DailyProductData")
        .doc(
          today.getMonth() +
            1 +
            "-" +
            today.getDate() +
            "-" +
            today.getFullYear()
        )
        .collection("Products")
        .doc(product.id);
      batch.set(docRef, product);
    });
    batch.commit();
  });
exports.searchForProduct = functions
  .runWith({ timeoutSeconds: 540, memory: "2GB" })
  .https.onCall(async (data, context) => {
    const today = new Date();
    const productsBasic = await db
      .collection("DailyProductData")
      .doc(
        today.getMonth() + 1 + "-" + today.getDate() + "-" + today.getFullYear()
      )
      .get();
    console.error(data.searchText);
    const productsBasicData = await productsBasic.data()?.products;
    let filteredProducts = searchAlg(data.searchText, productsBasicData);
    console.error(filteredProducts);
    const products = await db.getAll(
      ...filteredProducts.splice(0, 20).map(({ id }) =>
        db
          .collection("DailyProductData")
          .doc(
            today.getMonth() +
              1 +
              "-" +
              today.getDate() +
              "-" +
              today.getFullYear()
          )
          .collection("Products")
          .doc(id)
      )
    );
    return {
      products: products.map((doc, index) => ({
        ...doc.data(),
        coefficient: filteredProducts[index].coefficient,
      })),
    };
  });
exports.getDailyProducts = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onCall(async (data, context) => {
    const today = new Date();
    const limit: number = data.limit;
    let productsParsed: any[] = [];
    try {
      const products = db
        .collection("DailyProductData")
        .doc(
          today.getMonth() +
            1 +
            "-" +
            today.getDate() +
            "-" +
            today.getFullYear()
        )
        .collection("Products");
      productsParsed = (await products.limit(limit).get()).docs.map((doc) =>
        doc.data()
      );
    } catch (e) {
      console.error(e);
    }
    return {
      products: productsParsed,
    };
  });
exports.getAllProducts = functions.https.onCall(async (data, context) => {
  const products = db.collection("Products");
  return {
    products: (await products.get()).docs.map((doc) => ({
      ...doc.data(),
      id: doc.id,
    })),
  };
});
const siteEnums = {
  AMAZON: "amazon",
  BEST_BUY: "bestbuy",
  EBAY: "ebay",
  WALMART: "walmart",
  TARGET: "target",
};
const containsBannedWord = (title: string, words: string[]) => {
  for (let i = 0; i < words.length; i++) {
    if (title.includes(words[i])) {
      return true;
    }
  }
  return false;
};
const scrapeSite = async (
  allProducts: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>,
  baseUrl: string,
  firstHalfSiteUrl: string,
  secondHalfSiteUrl: string,
  productIdentifiers: any[],
  titleIdentifiers: string[],
  priceIdentifier: string,
  urlIdentifier: string,
  imageUrlIdentifier: string,
  siteEnum: string
) => {
  const htmlFound: any = { siteEnum };
  for (let i = 0; i < allProducts.docs.length; i++) {
    const id = allProducts.docs[i].id;
    // allProducts.forEach(({ doc }: { doc: { data: Function } }) => {
    const { name, bannedWords } = allProducts.docs[i].data();
    htmlFound[id] = { avgPrice: -1, bestIndex: -1, allListings: [] };
    await fetch(
      firstHalfSiteUrl +
        encodeURIComponent(name).replace(/%20/g, "+") +
        secondHalfSiteUrl
    ).then(async (response) => {
      let html = await response.text();
      if (response.status === 200) {
        const $ = cheerio.load(html);
        productIdentifiers.forEach((productIdentifier) => {
          $(productIdentifier)
            .toArray()
            .splice(0, 6)
            .forEach((item, i) => {
              let title = "";
              let j = 0;
              while (!title) {
                title = $(item).find(titleIdentifiers[j]).text();
                j++;
              }
              if (
                siteEnum === siteEnums.EBAY &&
                title.includes("NEW LISTING")
              ) {
                title = title.substring(11);
              }
              let lowerCaseTitle = title.toLowerCase();
              if (
                !containsBannedWord(lowerCaseTitle, bannedWords) &&
                (lowerCaseTitle.includes(name) ||
                  compare(name, lowerCaseTitle) > 0.6)
              ) {
                let price: string | undefined = $(item)
                  .find(priceIdentifier)
                  .text();
                if (siteEnum === siteEnums.WALMART && price.includes("From")) {
                  price = price.substring(6);
                }
                if (siteEnum === siteEnums.TARGET && price.includes("-")) {
                  price = "";
                }
                if (price?.includes("$")) {
                  price = price.substring(1);
                }
                if (price.includes(",")) {
                  price =
                    price.substring(0, price.indexOf(",")) +
                    price.substring(price.indexOf(",") + 1);
                }
                if (isNaN(parseFloat(price))) {
                  console.log(price);
                  price = undefined;
                }
                if (price && title) {
                  let url = $(item).find(urlIdentifier).attr().href;
                  let imageUrl = $(item).find(imageUrlIdentifier).attr().src;
                  if (
                    siteEnum === siteEnums.WALMART ||
                    siteEnum === siteEnums.AMAZON
                  ) {
                    url = baseUrl + url;
                    if (siteEnum === siteEnums.AMAZON) {
                      url = url + "&tag=yoyogogo-20";
                    }
                  }
                  htmlFound[id].allListings.push({
                    title: title,
                    price: parseFloat(price),
                    url,
                    imageUrl,
                  });
                }
              }
            });
        });
        let total = 0;
        let lowest =
          htmlFound[id].allListings.length > 0
            ? htmlFound[id].allListings[0].price
            : 1000000;
        let lowestIndex = htmlFound[id].allListings.length > 0 ? 0 : -1;
        htmlFound[id].allListings.forEach((listing: any, index: number) => {
          total += listing.price;
          if (listing.price < lowest) {
            lowest = listing.price;
            lowestIndex = index;
          }
        });
        htmlFound[id].bestIndex = lowestIndex;
        // console.log(htmlFound[id].allListings[lowestIndex].url);
        // console.log(htmlFound[id].allListings[lowestIndex].imageUrl);
        // console.log("\n");
        htmlFound[id].avgPrice =
          lowestIndex === -1 ? -1 : total / htmlFound[id].allListings.length;
      }
    });
  }
  //console.error(htmlFound);
  return htmlFound;
};

const scraperMain = async () => {
  const allProducts = await productsColl.get();
  console.time("loadingSpeed");
  let allSiteData = await Promise.all([
    scrapeSite(
      allProducts,
      "https://www.amazon.com",
      "https://www.amazon.com/s?k=",
      "",
      [
        "div.s-result-item.s-asin.sg-col-0-of-12.sg-col-16-of-20.sg-col.s-widget-spacing-small.sg-col-12-of-16",
        "div.sg-col-4-of-12.s-result-item.s-asin.sg-col-4-of-16.sg-col.s-widget-spacing-small.sg-col-4-of-20",
      ],
      [
        "span.a-size-medium.a-color-base.a-text-normal",
        "span.a-size-base-plus.a-color-base.a-text-normal",
      ],
      "span.a-offscreen",
      "a.a-link-normal.s-no-outline",
      "img.s-image",
      siteEnums.AMAZON
    ),
    // scrapeSite(
    //   allProducts,
    //   "https://www.bestbuy.com/site/searchpage.jsp?st=",
    //   "",
    //   "li.sku-item",
    //   "div > div > div.right-column > div.information > div:nth-child(2) > div.sku-title > h4 > a",
    //   "div > div > div.right-column > div.price-block > div.sku-list-item-price > div > div > div > div > div > div > div > div:nth-child(1) > div > div:nth-child(1) > div > span:nth-child(1)",
    //   siteEnums.BEST_BUY
    // ),
    scrapeSite(
      allProducts,
      "https://www.ebay.com",
      "https://www.ebay.com/sch/i.html?_nkw=",
      "&rt=nc&LH_BIN=1",
      ["li.s-item.s-item__pl-on-bottom.s-item--watch-at-corner"],
      [".s-item__title"],
      "span.s-item__price",
      "a.s-item__link",
      "img.s-item__image-img",
      siteEnums.EBAY
    ),
    // scrapeSite(
    //   allProducts,
    //   "https://www.walmart.com",
    //   "https://www.walmart.com/search?q=",
    //   "",
    //   "div.mb1.ph1.pa0-xl.bb.b--near-white.w-25",
    //   "span.f6.f5-l.normal.dark-gray.mb0.mt1.lh-title",
    //   "div.b.black.f5.mr1.mr2-xl.lh-copy.f4-l",
    //   "a.absolute.w-100.h-100.z-1",
    //   "img.absolute.top-0.left-0",
    //   siteEnums.WALMART
    // ),
    //   scrapeSite(
    //     "https://www.target.com/s?searchTerm=",
    //     "",
    //     "div.styles__StyledCol-sc-ct8kx6-0.ebNJlV",
    //     "a.Link__StyledLink-sc-4b9qcv-0.styles__StyledTitleLink-sc-h3r0um-1.csEnsr.dAyBrL.h-display-block.h-text-bold.h-text-bs",
    //     "div > section > div > div:nth-child(2) > div > div > div:nth-child(2) > div > div > div:nth-child(2) > div:nth-child(1) > div.h-padding-r-tiny > div > span",
    //     siteEnums.TARGET
    //   )
  ]);
  let overallProductData: any[] = [];
  allProducts.docs.forEach((doc) => {
    const { name } = doc.data();
    const id = doc.id;
    overallProductData.push({
      name,
      id,
      avgPrice: -1,
      bestEnum: "",
    });
    let total = 0;
    let validSites = 0;
    let lowest =
      allSiteData[0][id].bestIndex > -1
        ? allSiteData[0][id].allListings[allSiteData[0][id].bestIndex].price
        : 1000000;
    let lowestEnum =
      allSiteData[0][id].bestIndex > -1
        ? allSiteData[0].siteEnum
        : allSiteData[1].siteEnum;
    allSiteData.forEach((siteData) => {
      overallProductData[overallProductData.length - 1][siteData.siteEnum] =
        siteData[id];
      if (siteData[id].avgPrice > 0) {
        total += siteData[id].avgPrice;
        validSites++;
      }
      if (
        siteData[id].bestIndex > -1 &&
        siteData[id].allListings[siteData[id].bestIndex].price < lowest
      ) {
        lowest = siteData[id].allListings[siteData[id].bestIndex].price;
        lowestEnum = siteData.siteEnum;
      }
    });
    overallProductData[overallProductData.length - 1].avgPrice =
      total / validSites;
    overallProductData[overallProductData.length - 1].bestEnum = lowestEnum;
    if (
      isNaN(
        parseFloat(overallProductData[overallProductData.length - 1].avgPrice)
      )
    ) {
      overallProductData.splice(overallProductData.length - 1, 1);
    } else {
      const today = new Date();
      const docRef = db
        .collection("DailyProductData")
        .doc(
          today.getMonth() +
            1 +
            "-" +
            today.getDate() +
            "-" +
            today.getFullYear()
        )
        .collection("Products")
        .doc(id);
      batch.set(docRef, overallProductData[overallProductData.length - 1]);
    }
  });
  const today = new Date();
  const docRef = db
    .collection("DailyProductData")
    .doc(
      today.getMonth() + 1 + "-" + today.getDate() + "-" + today.getFullYear()
    );
  batch.set(docRef, {
    products: overallProductData.map(({ id, name }) => ({
      id,
      name,
    })),
  });
  //console.error(overallProductData);
  batch.commit();
  console.timeEnd("loadingSpeed");
  // console.log(overallProductData);
};
