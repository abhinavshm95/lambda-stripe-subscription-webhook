const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const axios = require("axios");

exports.handler = async event => {
    if (process.env.STRIPE_WEBHOOK_APP_SECRET) {
        try {
            let stripeEvent;
            const stripeSignature = event.headers["stripe-signature"];

            try {
                // Extract the object from the event.
                stripeEvent = stripe.webhooks.constructEvent(event.body, stripeSignature, process.env.STRIPE_WEBHOOK_APP_SECRET);
            } catch (error) {
                console.log("Webhook signature verification failed :: ", error);
                return { statusCode: 400 };
            }

            const eventData = stripeEvent.data;
            const eventDataObject = eventData.object;

            switch (stripeEvent.type) {
                case "checkout.session.completed":
                    if (eventData && eventData.object && eventData.object.mode && eventData.object.mode === "subscription") {
                        const stripeSubData = await stripe.subscriptions.retrieve(eventDataObject.subscription);
                        const latestSubInvoice = await stripe.invoices.retrieve(stripeSubData.latest_invoice);

                        if (latestSubInvoice.billing_reason === "subscription_create") {
                            await updateAuthZeroUserSubAppMetadata(
                                stripeSubData.metadata.authUserID,
                                stripeSubData,
                                latestSubInvoice,
                                stripeEvent.id
                            );
                        }
                    }
                    break;
                case "invoice.payment_succeeded": // For Subscription Renew & Payment is debited
                    if (
                        eventData &&
                        eventData.object &&
                        eventData.object.object === "invoice" &&
                        eventData.object.billing_reason === "subscription_cycle"
                    ) {
                        const stripeSubData = await stripe.subscriptions.retrieve(eventDataObject.subscription);
                        const latestSubInvoice = await stripe.invoices.retrieve(stripeSubData.latest_invoice);

                        await updateAuthZeroUserSubAppMetadata(
                            stripeSubData.metadata.authUserID,
                            stripeSubData,
                            latestSubInvoice,
                            stripeEvent.id
                        );
                    }
                    break;
                case "customer.subscription.deleted":
                case "customer.subscription.updated": // Trial End && Sub Cancled && Convert user from Premium to Normal User
                    if (eventData && eventData.object && eventData.object.object === "subscription") {
                        try {
                            console.log("--customer.subscription.updated--");
                            const stripeSubData = await stripe.subscriptions.retrieve(eventDataObject.id);
                            const latestSubInvoice = await stripe.invoices.retrieve(stripeSubData.latest_invoice);

                            await updateAuthZeroUserSubAppMetadata(
                                stripeSubData.metadata.authUserID,
                                stripeSubData,
                                latestSubInvoice,
                                stripeEvent.id
                            );
                        } catch (error) {
                            console.log("Error while updating the user subscription");
                            throw new Error(error);
                        }
                    }
                    break;
                default:
                    console.log("Unexpected EVENT Type STRIPE");
                    return { statusCode: 400 };
            }

            return { statusCode: 200 };
        } catch (err) {
            console.log("Webhook signature verification failed :: ", err);
            return { statusCode: 400 };
        }
    } else {
        console.log("No webhook secret found. Skipping signature check.");
        return { statusCode: 400 };
    }
};

async function updateAuthZeroUserSubAppMetadata(authUserID, stripeSubData, latestSubInvoice, eventID) {
    try {
        const stripeSubscription = {
            status: stripeSubData.status,
            id: stripeSubData.id,
            latest_invoice_id: stripeSubData.latest_invoice,
            event_id: eventID,
            plan_id: stripeSubData.plan.id,
            product_id: stripeSubData.plan.product,
            end_date: stripeSubData.current_period_end,
            cancelled_at: stripeSubData.canceled_at,
            cancel_at: stripeSubData.cancel_at,
            cancel_at_period_end: stripeSubData.cancel_at_period_end,
            hosted_invoice_url: latestSubInvoice.hosted_invoice_url,
        };

        await updateUserMetadata(authUserID, stripeSubscription, stripeSubData.customer);
    } catch (error) {
        console.log("Error while updating the user subscription", error);
        throw new Error(error);
    }
}

async function updateUserMetadata(authUserID, stripeSubscription, customerID) {
    const updateMetadataBody = JSON.stringify({
        app_metadata: {
            stripe: {
                subscription: stripeSubscription,
                customer_id: customerID,
            },
        },
    });

    // get access token
    const getAccessTokenData = JSON.stringify({
        client_id: "QmtVg0jtbK3AmZMh7gjzbI25CLLaCADS",
        client_secret: process.env.AUTH_ZERO_CLIENT_SECRET,
        audience: "https://sabr-sports.us.auth0.com/api/v2/",
        grant_type: "client_credentials",
    });

    const tokenConfig = {
        method: "post",
        url: "https://sabr-sports.us.auth0.com/oauth/token",
        headers: {
            "content-type": "application/json"
        },
        data: getAccessTokenData,
    };

    try {

        const accessTokenRes = await axios(tokenConfig);

        const updateAppdataConfig = {
            method: "patch",
            url: `https://${process.env.AUTH_ZERO_DOMAIN}/api/v2/users/` + authUserID,
            headers: {
                Authorization: `Bearer ${accessTokenRes.data.access_token}`,
                "Content-Type": "application/json",
            },
            data: updateMetadataBody,
        };

        return await axios(updateAppdataConfig);
    } catch (error) {
        console.log("Error while updating the user subscription", error);
        throw new Error(error);
    }
}
