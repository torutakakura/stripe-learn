import { stripe } from "@/lib/stripe";
import { Article, ArticleAccessLevelType, SubscriptionLevelType } from "@prisma/client";
import Stripe from "stripe";
import { getUserById, updateUserCustomerId } from "../store/user";
import { PREMIUM_PRICE, STANDARD_PRICE } from "../constraints/constraints";

export const createCustomerId = async ({ userId }: { userId: string }) => {
    try {
        const user = await getUserById({ userId });
        if (!user) {
            throw new Error(`ユーザーが存在しません。userId: ${userId}`);
        }

        // すでに customerId が登録されている場合、何もしない
        if (user.customerId) {
            return;
        }

        const isProduction = process.env.NODE_ENV === "production";

        // customerを作成する
        const customer = await stripe.customers.create({
            email: user.email,
            name: user.name,
            test_clock: isProduction ? undefined : process.env.STRIPE_TEST_CLOCK_ID,
            // custmerの言語を日本語に設定します
            preferred_locales: ["ja"],
            metadata: {
                userId,
            },
        });

        // userにcustomerIdを登録します
        await updateUserCustomerId({ userId, customerId: customer.id });

        return;
    } catch (error) {
        throw error;
    }
};

export const getStripePrices = async () => {
    try {
        // price オブジェクトのリストを取得。
        // lookup_keys は、前回登録した検索キーです
        // expand で product オブジェクトも取得するようにします。
        const prices = await stripe.prices.list({
            lookup_keys: ["premium", "standard"],
            expand: ["data.product"],
        });
        return prices.data;
    } catch (error) {
        throw error;
    }
};

// 前回登録したメタデータを SubscriptionLevelType の "Premium", "Standard" に変換します
export const getLevelFromMetadata = (
    metadata: Stripe.Metadata
): SubscriptionLevelType => {
    switch (metadata.level) {
        case "Premium": {
            return SubscriptionLevelType.Premium;
        }
        case "Standard": {
            return SubscriptionLevelType.Standard;
        }
        default: {
            throw new Error("Metadata.level が存在しません。metadata:", metadata);
        }
    }
};


// stripeからオンライン決済用のURLを取得します。
export const getSubscriptionCheckoutURL = async ({
    userId,
    priceId,
}: {
    userId: string;
    priceId: string;
}) => {
    try {
        const user = await getUserById({ userId });
        if (!user) {
            throw new Error(`ユーザーが存在しません。userId: ${userId}`);
        }

        const customerId = user.customerId;
        if (!customerId) {
            throw new Error(`カスタマーIDが存在しません。userId: ${userId}`);
        }

        // stripe.checkout を作成します。
        const session = await stripe.checkout.sessions.create({
            success_url: `${process.env.NEXT_PUBLIC_APP_URL}/success`,
            cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout`,
            // カード決済
            payment_method_types: ["card"],
            // サブスクリプション
            mode: "subscription",
            customer: customerId,
            line_items: [{ price: priceId, quantity: 1 }],
            // カード決済時の住所入力をstripeに任せます
            billing_address_collection: "auto",
            shipping_address_collection: {
                allowed_countries: ["JP"],
            },
            metadata: {
                userId,
            },
            // subscriotionオブジェクトにもmetadataを含めるよう設定します。
            subscription_data: {
                metadata: {
                    userId,
                },
            },
        });

        return session.url;
    } catch (error) {
        throw error;
    }
};

export const getBillingPortalURL = async ({
    customerId,
    returnPath,
}: {
    customerId: string;
    returnPath: string;
}) => {
    const returnURL = new URL(
        returnPath,
        process.env.NEXT_PUBLIC_APP_URL as string
    );
    try {
        const billingPortal = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnURL.toString(),
        });
        return billingPortal.url;
    } catch (error) {
        throw error;
    }
};


// 1回きりの購入決済用のURLを取得します
export const getPurchaseCheckoutURL = async ({
    userId,
    article,
}: {
    userId: string;
    article: Article;
}) => {
    try {
        const user = await getUserById({ userId });
        if (user === null) {
            throw new Error("ユーザーが存在しません");
        }
        const customerId = user.customerId;
        if (customerId === null) {
            throw new Error(`カスタマーIDが存在しません。userId: ${user.id}`);
        }

        const params = new URLSearchParams();
        params.set("article_id", article.id);

        const articlePrice =
            article.accessLevel === ArticleAccessLevelType.Premium
                ? PREMIUM_PRICE
                : STANDARD_PRICE;

        const checkoutSession = await stripe.checkout.sessions.create({
            success_url: `${process.env.NEXT_PUBLIC_APP_URL
                }/success?${params.toString()}`,
            cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/checkout`,
            payment_method_types: ["card"],
            mode: "payment",
            customer: customerId,
            billing_address_collection: "auto",
            line_items: [
                {
                    price_data: {
                        currency: "jpy",
                        product_data: {
                            name: `${article.title} の記事`,
                        },
                        unit_amount: articlePrice,
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                userId,
                articleId: article.id,
            },
            // 1回きりの購入は payment_intent イベントで管理します。
            // なので payment_intent にmetadataを含めるように指定します
            payment_intent_data: {
                metadata: {
                    userId,
                    articleId: article.id,
                },
                capture_method: "manual",
            },
        });
        return checkoutSession.url;
    } catch (error) {
        throw error;
    }
};

export const getShippingByCustomerID = async ({
    customerId,
}: {
    customerId: string;
}) => {
    try {
        const res = await stripe.customers.retrieve(customerId);

        // 顧客が削除されている場合は、customer.shippingが取得できないのでエラーにする
        if (res.deleted) {
            throw new Error("顧客が削除されています");
        }
        const customer = res as Stripe.Customer;

        return customer.shipping;
    } catch (error) {
        throw error;
    }
};
